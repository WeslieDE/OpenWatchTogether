// Package room haelt pro aktivem Watch-Together-Raum eine Zustandsmaschine:
// eine Hub-Verbindung als ganz normaler Peer ("HLSStream"), einen dauerhaften
// HLS-Encoder und eine Quelle (Datei/Live/Standbild), die je nach
// Hub-Nachrichten ausgetauscht wird. Alles unten laeuft in genau einer
// Goroutine (loop()) - kein Mutex fuer den Raumzustand noetig, nur fuer den
// von aussen (HTTP) beruehrten "zuletzt gesehen"-Zeitstempel.
package room

import (
	"log"
	"math"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"tk.weslie/watch-together-hlsstream/internal/config"
	"tk.weslie/watch-together-hlsstream/internal/hub"
	"tk.weslie/watch-together-hlsstream/internal/pipeline"
	"tk.weslie/watch-together-hlsstream/internal/sfuclient"
)

// driftTolerance: erst ab so viel Abweichung zwischen der eigenen
// hochgerechneten Position und der vom Takt gemeldeten wird die laufende
// Datei-Quelle neu angesetzt (Spruenge/Suchen) - die periodischen ~2s-
// Taktmeldungen selbst sollen nicht staendig neu anfahren.
const driftTolerance = 2.0

type liveResult struct {
	epoch      int
	session    *sfuclient.Session
	videoTrack sfuclient.Track
	audioTrack *sfuclient.Track
	err        error
}

// sourceExit meldet, dass einer der beiden Prozesse der aktuellen Quelle von
// selbst geendet hat - normalerweise, weil switchTo() sie absichtlich
// gekillt hat (dann ist generation laengst veraltet und wird ignoriert),
// manchmal aber auch unerwartet, etwa wenn ffmpeg an einer Position jenseits
// des Dateiendes nichts zu lesen findet. Ohne diese Meldung saehe der
// Encoder fuer immer keine neuen Frames mehr und die Playlist stuende still.
type sourceExit struct {
	generation int
	err        error
}

type Room struct {
	slug string
	cfg  config.Config

	hubC    *hub.Client
	pipes   *pipeline.Pipes
	encoder *pipeline.Encoder

	quit      chan struct{}
	done      chan struct{}
	closeOnce sync.Once

	lastSeen atomic.Int64
	denied   atomic.Bool

	liveReady    chan liveResult
	sourceExitCh chan sourceExit

	// Alles ab hier wird ausschliesslich von loop() angefasst.
	sourceKind    string // "", "idle", "file", "live"
	sourceGen     int
	currentSource *pipeline.SourcePair

	nowID      *string
	queue      map[string]hub.QueueItem
	playing    bool
	videoT     float64
	videoAt    time.Time
	settingsGo bool

	liveOn       bool
	liveEpoch    int
	liveSession  *sfuclient.Session
	liveReadyOK  bool
	liveVideoSDP string
	liveAudioSDP string // leer = keine Tonspur gemeldet

	appliedItemID string
	appliedT      float64
	appliedAt     time.Time
}

func New(cfg config.Config, slug string) (*Room, error) {
	pipes, err := pipeline.NewPipes()
	if err != nil {
		return nil, err
	}
	outDir := filepath.Join(cfg.HLSDataDir, slug)
	encoder, err := pipeline.NewEncoder(cfg.FFmpegPath, outDir, slug, pipes.VideoR, pipes.AudioR)
	if err != nil {
		pipes.Close()
		return nil, err
	}

	r := &Room{
		slug:         slug,
		cfg:          cfg,
		pipes:        pipes,
		encoder:      encoder,
		quit:         make(chan struct{}),
		done:         make(chan struct{}),
		liveReady:    make(chan liveResult, 4),
		sourceExitCh: make(chan sourceExit, 4),
		queue:        map[string]hub.QueueItem{},
	}
	r.Touch()
	r.hubC = hub.Connect(cfg.HubHost, cfg.HubPort, slug)
	go r.loop()
	return r, nil
}

func (r *Room) Slug() string { return r.slug }
func (r *Room) Denied() bool { return r.denied.Load() }
func (r *Room) Touch()       { r.lastSeen.Store(time.Now().Unix()) }
func (r *Room) IdleFor() time.Duration {
	return time.Since(time.Unix(r.lastSeen.Load(), 0))
}

// Close beendet den Raum vollstaendig und wartet, bis alle Prozesse und
// Verbindungen zu sind - danach darf der Aufrufer den Segmentordner loeschen.
func (r *Room) Close() {
	r.closeOnce.Do(func() { close(r.quit) })
	<-r.done
}

/* -------------------------------------------------------------- Hauptschleife */

// posInterval: wie oft HLSStream seine eigene Position meldet - dieselbe
// Kadenz, in der ein Browser sie meldet (POS_MS in assets/js/net.js).
const posInterval = time.Second

func (r *Room) loop() {
	defer close(r.done)
	defer r.teardown()

	posTick := time.NewTicker(posInterval)
	defer posTick.Stop()

	for {
		select {
		case <-r.quit:
			return

		case ev, ok := <-r.hubC.Events():
			if !ok {
				return
			}
			r.handleHub(ev)

		case res := <-r.liveReady:
			r.handleLiveReady(res)

		case exit := <-r.sourceExitCh:
			r.handleSourceExit(exit)

		case <-posTick.C:
			r.sendPos()
		}
	}
}

// sendPos meldet dem Hub die eigene Position in der Teilnehmerliste - immer
// exakt die des Taktgebers, denn HLSStream spielt ja nichts Eigenes: es
// rechnet, wie auch die Quellwahl in desired(), einfach dessen gemeldete
// Zeit hoch. Ohne diese Meldung bliebe HLSStream in der Liste dauerhaft bei
// 0:00 stehen, statt sichtbar mitzulaufen.
func (r *Room) sendPos() {
	r.hubC.Send("pos", struct {
		T float64 `json:"t"`
	}{r.currentPosition()})
}

func (r *Room) teardown() {
	r.currentSource.Stop()
	if r.liveSession != nil {
		r.liveSession.Close()
	}
	r.encoder.Close()
	r.hubC.Close()
	// Kurze Gnadenfrist, bevor der Aufrufer den Ordner loescht - die eben
	// gekillten ffmpeg-Prozesse brauchen einen Moment, um ihre Dateihandles
	// loszulassen (unschaedlich, falls nicht: unlink auf offene Dateien ist
	// unter Linux immer erlaubt, siehe Kommentar in manager.go).
	time.Sleep(150 * time.Millisecond)
	r.pipes.Close()
}

/* ---------------------------------------------------------- Hub-Nachrichten */

func (r *Room) handleHub(ev hub.Event) {
	switch ev.Kind {
	case "connected":
		r.assertGo()

	case "welcome":
		r.nowID = ev.Welcome.Now
		r.queue = indexQueue(ev.Welcome.Queue)
		r.playing = ev.Welcome.Video.Playing
		r.videoT = ev.Welcome.Video.T
		r.videoAt = time.Now()
		r.settingsGo = ev.Welcome.Settings.Go
		r.liveOn = ev.Welcome.Live.On
		if !r.liveOn {
			r.liveReadyOK = false
		}
		r.assertGo()
		r.assertReady()
		r.applySource()

	case "video":
		r.playing = ev.Video.Playing
		r.videoT = ev.Video.T
		r.videoAt = time.Now()
		r.applySource()

	case "now":
		r.nowID = ev.NowID
		r.assertReady()
		r.applySource()

	case "queue":
		r.queue = indexQueue(ev.Queue)
		r.applySource()

	case "settings":
		wasGo := r.settingsGo
		r.settingsGo = ev.Settings.Go
		if r.settingsGo && !wasGo {
			r.assertGo()
		}

	case "live":
		r.liveOn = ev.Live.On
		if r.liveOn {
			r.liveEpoch++
			r.liveReadyOK = false
			epoch := r.liveEpoch
			go r.startLive(epoch)
		} else {
			r.liveReadyOK = false
			if r.liveSession != nil {
				r.liveSession.Close()
				r.liveSession = nil
			}
		}
		r.applySource()

	case "denied":
		log.Printf("[hls %s] Beitritt abgelehnt (%s), Raum wird nicht bedient", r.slug, ev.Denied)
		r.denied.Store(true)
	}
}

func (r *Room) assertGo() {
	if r.settingsGo {
		r.hubC.Send("go", struct {
			On bool `json:"on"`
		}{true})
	}
}

// assertReady meldet dem Hub, dass das gerade laufende Video "im Puffer"
// liegt - HLSStream muss dafuer, anders als ein Browser, nie wirklich etwas
// laden (Datei/Live/Standbild sind untereinander austauschbar, siehe
// switchTo()). Ohne diese Meldung bliebe sein "ready" beim Server dauerhaft
// leer, und der Taktgeber wartet in startWhenAllReady() (assets/js/app.js)
// auf jeden Teilnehmer - ein neues Video ginge dann nie von selbst los,
// solange HLSStream im Raum ist.
func (r *Room) assertReady() {
	if r.nowID == nil {
		return
	}
	r.hubC.Send("ready", struct {
		Item string `json:"item"`
	}{*r.nowID})
}

func indexQueue(items []hub.QueueItem) map[string]hub.QueueItem {
	out := make(map[string]hub.QueueItem, len(items))
	for _, it := range items {
		out[it.ID] = it
	}
	return out
}

/* -------------------------------------------------------------- Quellwahl */

// desired sagt, was gerade zu sehen sein sollte - reine Ableitung aus dem
// gespiegelten Raumzustand, ohne Nebenwirkung.
func (r *Room) desired() (kind string, item hub.QueueItem, startAt float64) {
	if r.liveOn {
		if r.liveReadyOK {
			return "live", hub.QueueItem{}, 0
		}
		// Uebertragung angekuendigt, aber die SFU-Handshake laeuft noch -
		// Standbild ueberbruecken statt eine veraltete Datei weiterlaufen
		// zu lassen.
		return "idle", hub.QueueItem{}, 0
	}
	if r.nowID == nil {
		return "idle", hub.QueueItem{}, 0
	}
	it, ok := r.queue[*r.nowID]
	if !ok {
		return "idle", hub.QueueItem{}, 0
	}
	if !r.playing {
		return "idle", hub.QueueItem{}, 0
	}
	pos := r.currentPosition()
	// Die eigene Hochrechnung kann ueber das Ende der Datei hinauslaufen -
	// etwa wenn der Raum seit der letzten "video"-Meldung sehr lange keine
	// neue mehr geschickt hat. Ein -ss jenseits der Laufzeit liefert von
	// ffmpeg aus gar nichts (der Encoder saehe dann fuer immer keine neuen
	// Frames mehr) - dann lieber das Standbild, wie am echten Ende auch.
	if it.Duration > 0 && pos >= it.Duration-0.25 {
		return "idle", hub.QueueItem{}, 0
	}
	return "file", it, pos
}

func (r *Room) currentPosition() float64 {
	if !r.playing {
		return r.videoT
	}
	return r.videoT + time.Since(r.videoAt).Seconds()
}

// applySource vergleicht, was laufen sollte, mit dem, was tatsaechlich
// laeuft, und wechselt nur, wenn sich das Ergebnis wirklich unterscheidet -
// die periodischen Taktmeldungen des Raums sollen nicht staendig neu
// anfahren, siehe driftTolerance.
func (r *Room) applySource() {
	kind, item, startAt := r.desired()

	changedKind := kind != r.sourceKind
	changedItem := kind == "file" && item.ID != r.appliedItemID
	drifted := false
	if kind == "file" && !changedKind && !changedItem {
		expected := r.appliedT + time.Since(r.appliedAt).Seconds()
		drifted = math.Abs(startAt-expected) > driftTolerance
	}

	if !changedKind && !changedItem && !drifted {
		return
	}
	r.switchTo(kind, item, startAt)
}

func (r *Room) switchTo(kind string, item hub.QueueItem, startAt float64) {
	log.Printf("[hls %s] Quelle: %s -> %s", r.slug, r.sourceKind, kind)
	r.currentSource.Stop()
	r.currentSource = nil

	var proc *pipeline.SourcePair
	var err error

	switch kind {
	case "file":
		diskPath := filepath.Join(r.cfg.DataDir, item.URL)
		hasAudio := pipeline.HasAudioStream(r.cfg.FFprobePath, diskPath)
		proc, err = pipeline.StartFileSource(r.cfg.FFmpegPath, r.slug, diskPath, startAt, hasAudio, r.pipes)
		if err == nil {
			r.appliedItemID = item.ID
			r.appliedT = startAt
			r.appliedAt = time.Now()
		}

	case "live":
		proc, err = pipeline.StartLiveSource(r.cfg.FFmpegPath, r.slug, r.liveVideoSDP, r.liveAudioSDP, r.pipes)

	default: // "idle"
		proc, err = pipeline.StartIdleSource(r.cfg.FFmpegPath, r.slug, r.cfg.PausedImage, r.pipes)
	}

	if err != nil {
		log.Printf("[hls %s] Quelle %q fehlgeschlagen: %v", r.slug, kind, err)
		if kind != "idle" {
			proc, _ = pipeline.StartIdleSource(r.cfg.FFmpegPath, r.slug, r.cfg.PausedImage, r.pipes)
			kind = "idle"
		}
	}

	r.currentSource = proc
	r.sourceKind = kind
	r.sourceGen++
	if proc != nil {
		go r.watchSourceExit(proc, r.sourceGen)
	}
}

// watchSourceExit meldet, sobald einer der beiden Prozesse einer Quelle
// endet - ob gewollt (switchTo() killt sie beim naechsten Wechsel, dann ist
// generation laengst ueberholt) oder unerwartet. Nur der erste der beiden
// zaehlt; das reicht, um die Zustandsmaschine aufzuwecken.
func (r *Room) watchSourceExit(pair *pipeline.SourcePair, generation int) {
	var err error
	select {
	case err = <-pair.Video.Done():
	case err = <-pair.Audio.Done():
	}
	select {
	case r.sourceExitCh <- sourceExit{generation: generation, err: err}:
	case <-r.quit:
	}
}

// handleSourceExit reagiert nur, wenn die gemeldete Quelle noch die
// aktuelle ist - laengst abgeloeste Generationen (der Normalfall bei jedem
// gewollten Wechsel) werden stillschweigend ignoriert.
func (r *Room) handleSourceExit(exit sourceExit) {
	if exit.generation != r.sourceGen {
		return
	}
	log.Printf("[hls %s] Quelle %q unerwartet beendet (%v) - wechsle auf Standbild", r.slug, r.sourceKind, exit.err)
	if r.sourceKind == "idle" {
		// Selbst das Standbild ist gerade weggebrochen - mehr laesst sich
		// hier nicht tun, das naechste Hub-Ereignis versucht es erneut.
		return
	}
	r.switchTo("idle", hub.QueueItem{}, 0)
}

/* -------------------------------------------------------- Live-Aufbau (SFU) */

// startLive laeuft in einer eigenen Goroutine, weil der Handshake mit dem SFU
// mehrere Netzwerk-Umlaeufe braucht - die Hauptschleife darf dabei nicht
// stillstehen. Das Ergebnis kommt ueber r.liveReady zurueck in loop().
func (r *Room) startLive(epoch int) {
	session, err := sfuclient.Open(r.cfg.SFUHost, r.cfg.SFUPort, r.slug)
	if err != nil {
		r.liveReady <- liveResult{epoch: epoch, err: err}
		return
	}

	var videoProd, audioProd *sfuclient.Producer
	deadline := time.After(5 * time.Second)
	for videoProd == nil {
		select {
		case p, ok := <-session.Events:
			if !ok {
				session.Close()
				r.liveReady <- liveResult{epoch: epoch, err: errNoVideoProducer}
				return
			}
			assignProducer(p, &videoProd, &audioProd)
		case <-deadline:
			session.Close()
			r.liveReady <- liveResult{epoch: epoch, err: errNoVideoProducer}
			return
		}
	}
	if audioProd == nil {
		select {
		case p, ok := <-session.Events:
			if ok {
				assignProducer(p, &videoProd, &audioProd)
			}
		case <-time.After(time.Second):
		}
	}

	videoPort, audioPort := session.NextPorts()
	videoTrack, err := session.Consume(*videoProd, videoPort)
	if err != nil {
		session.Close()
		r.liveReady <- liveResult{epoch: epoch, err: err}
		return
	}

	var audioTrack *sfuclient.Track
	if audioProd != nil {
		if at, err := session.Consume(*audioProd, audioPort); err == nil {
			audioTrack = &at
		}
	}

	r.liveReady <- liveResult{
		epoch:      epoch,
		session:    session,
		videoTrack: videoTrack,
		audioTrack: audioTrack,
	}
}

func assignProducer(p sfuclient.Producer, video, audio **sfuclient.Producer) {
	switch p.Kind {
	case "video":
		if *video == nil {
			pp := p
			*video = &pp
		}
	case "audio":
		if *audio == nil {
			pp := p
			*audio = &pp
		}
	}
}

func (r *Room) handleLiveReady(res liveResult) {
	if res.epoch != r.liveEpoch {
		// Inzwischen wurde die Uebertragung schon wieder umgeschaltet -
		// dieses Ergebnis ist veraltet.
		if res.session != nil {
			res.session.Close()
		}
		return
	}
	if res.err != nil {
		log.Printf("[hls %s] Live-Aufbau fehlgeschlagen: %v", r.slug, res.err)
		return
	}

	outDir := filepath.Join(r.cfg.HLSDataDir, r.slug)
	videoSDP, err := pipeline.WriteVideoSDP(outDir, res.videoTrack)
	if err != nil {
		log.Printf("[hls %s] Video-SDP konnte nicht geschrieben werden: %v", r.slug, err)
		res.session.Close()
		return
	}
	audioSDP := ""
	if res.audioTrack != nil {
		audioSDP, err = pipeline.WriteAudioSDP(outDir, *res.audioTrack)
		if err != nil {
			log.Printf("[hls %s] Audio-SDP konnte nicht geschrieben werden: %v", r.slug, err)
			// Kein Grund, die ganze Uebertragung abzubrechen - einfach ohne Ton.
			audioSDP = ""
		}
	}

	r.liveSession = res.session
	r.liveVideoSDP = videoSDP
	r.liveAudioSDP = audioSDP
	r.liveReadyOK = true
	r.applySource()
}

var errNoVideoProducer = &roomError{"kein Video-Producer innerhalb der Frist"}

type roomError struct{ s string }

func (e *roomError) Error() string { return e.s }
