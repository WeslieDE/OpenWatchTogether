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
	"strings"
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
	liveRetry    chan int
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
	liveSDP      string
	liveHasAudio bool
	liveVideo    sfuclient.Track

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
		liveRetry:    make(chan int, 4),
		sourceExitCh: make(chan sourceExit, 4),
		queue:        map[string]hub.QueueItem{},
	}
	r.Touch()
	r.hubC = hub.Connect(cfg.HubHost, cfg.HubPort, slug)
	go r.loop()
	return r, nil
}

func (r *Room) Slug() string { return r.slug }

// Playlist: die aktuelle HLS-Playlist des Raums, siehe
// pipeline.Encoder.Playlist().
func (r *Room) Playlist() ([]byte, error) { return r.encoder.Playlist() }
func (r *Room) Denied() bool              { return r.denied.Load() }
func (r *Room) Touch()                    { r.lastSeen.Store(time.Now().Unix()) }
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

		case epoch := <-r.liveRetry:
			r.handleLiveRetry(epoch)

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
		} else {
			// Die Uebertragung lief schon, bevor HLSStream dem Raum
			// beitrat - ohne diesen Aufruf saehe assertConnected() zwar
			// "verbunden" aus, aber der SFU-Handshake liefe nie an, und
			// desired() bliebe fuer immer bei "idle" (Standbild) haengen,
			// weil r.liveReadyOK nie true wird. Beim gewoehnlichen Weg
			// (Uebertragung startet, waehrend HLSStream schon im Raum
			// ist) uebernimmt das der "live"-Fall unten.
			r.startLiveHandshake()
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
			r.startLiveHandshake()
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

// assertConnected meldet dem Hub, dass HLSStream als "verbunden" gilt -
// anders als bei einem Browser (siehe "live-status" in app.js) haengt das
// hier nicht an einer eigenen SFU-Verbindung: HLSStream zieht sich die
// Bildschirmuebertragung erst bei Bedarf ueber sfuclient, ist als Dienst aber
// so gut wie immer erreichbar. Ohne diese Meldung bliebe sein Punkt in der
// Zuschauerliste (assets/js/app.js, renderViewers()) waehrend jeder
// Uebertragung faelschlich rot, obwohl von ihm keine echte Unterbrechung
// droht wie bei einem Browser-Tab.
func (r *Room) assertConnected() {
	r.hubC.Send("live-status", struct {
		Connected bool `json:"connected"`
	}{true})
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
	old := r.currentSource
	old.Stop()
	r.currentSource = nil

	// Bild und Ton vor der neuen Quelle wieder auf gleiche Laenge bringen,
	// sonst bliebe jeder Rest der alten Quelle als Versatz stehen (siehe
	// pipeline.Pipes.Align()).
	if frames, samples, err := r.pipes.Align(old.Forwarders()); err != nil {
		log.Printf("[hls %s] Bild/Ton-Abgleich fehlgeschlagen: %v", r.slug, err)
	} else if frames > 0 || samples > 0 {
		log.Printf("[hls %s] Bild/Ton angeglichen: +%d Bilder, +%dms Ton", r.slug, frames, samples*1000/pipeline.SampleRate)
	}

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
		proc, err = pipeline.StartLiveSource(r.cfg.FFmpegPath, r.slug, r.liveSDP, r.liveHasAudio, r.pipes,
			watchLiveLoss(r.liveSession, r.liveVideo))
		if err == nil {
			go requestKeyFrames(r.liveSession, r.liveVideo)
			go watchLiveStall(r.liveSession, r.liveVideo, r.pipes, proc.Forwarders()[0])
		}

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

// startLiveHandshake stoesst den SFU-Consume-Aufbau an - sowohl wenn eine
// Uebertragung neu beginnt (Hub-Ereignis "live"), als auch wenn HLSStream
// einem Raum beitritt, in dem schon gesendet wird (Hub-Ereignis "welcome"
// mit live.on=true): das SFU meldet jedem neu verbundenen Consumer laufende
// Producer von sich aus (siehe handleConnection() in sfu/server.js), es
// fehlt in diesem zweiten Fall also nur der Anstoss von hier aus, ueberhaupt
// eine Consume-Verbindung zum SFU aufzubauen.
func (r *Room) startLiveHandshake() {
	r.liveEpoch++
	r.liveReadyOK = false
	r.assertConnected()
	epoch := r.liveEpoch
	go r.startLive(epoch)
}

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
		log.Printf("[hls %s] Live-Aufbau fehlgeschlagen: %v - neuer Versuch in %v", r.slug, res.err, liveRetryDelay)
		go r.scheduleLiveRetry(res.epoch, liveRetryDelay)
		return
	}

	outDir := filepath.Join(r.cfg.HLSDataDir, r.slug)
	sdp, err := pipeline.WriteLiveSDP(outDir, res.videoTrack, res.audioTrack)
	if err != nil {
		log.Printf("[hls %s] Live-SDP konnte nicht geschrieben werden: %v", r.slug, err)
		res.session.Close()
		return
	}

	r.liveSession = res.session
	go r.watchLiveSession(res.session, res.epoch)
	r.liveSDP = sdp
	r.liveHasAudio = res.audioTrack != nil
	r.liveVideo = res.videoTrack
	r.liveReadyOK = true
	r.applySource()
}

// keyFrameDelays: wann nach dem Start der Live-Quelle ein frischer Keyframe
// angefordert wird. Der beim Resume des Consumers kam meist an, bevor ffmpeg
// lauschte - ohne neuen wartet das Bild bis zum naechsten von selbst
// gesendeten, bei einer Bildschirmuebertragung leicht viele Sekunden, und
// der Ton staut sich so lange im Encoder. Mehrfach, falls ffmpeg beim
// ersten Mal noch mit dem Einlesen der SDP beschaeftigt ist.
var keyFrameDelays = []time.Duration{300 * time.Millisecond, time.Second, 3 * time.Second}

func requestKeyFrames(session *sfuclient.Session, video sfuclient.Track) {
	if session == nil {
		return
	}
	var waited time.Duration
	for _, d := range keyFrameDelays {
		time.Sleep(d - waited)
		waited = d
		if err := session.RequestKeyFrame(video); err != nil {
			return
		}
	}
}

// liveStallCheck: wie oft watchLiveStall() nachsieht, ob die Live-Quelle
// noch Bilder liefert.
const liveStallCheck = time.Second

// watchLiveStall fordert so lange jede liveStallCheck einen frischen
// Keyframe an, wie die laufende Live-Quelle kein neues Bild an den Encoder
// weiterreicht - bis die Bild-Weiterleitung der Quelle leer gelaufen ist
// (done, siehe pipeline.SourcePair.Forwarders(); nicht Proc.Done(), das nur
// einmal lesbar ist und watchSourceExit() gehoert).
//
// Grund: steht das Bild, weil dem VP8-Decoder ein Keyframe fehlt, laeuft der
// Ton im selben Prozess weiter. Der Encoder liest die vorauslaufende Spur
// aber erst weiter, wenn die andere aufgeholt hat - nach rund 10s (siehe
// audioQueueChunks in internal/pipeline) ist der Tonpuffer voll, der Live-
// Prozess blockiert beim Schreiben des Tons und liest auch das RTP nicht
// mehr. Dann kommt der rettende Keyframe nie mehr an, und das Bild im HLS-
// Stream bleibt bis zum naechsten Quellwechsel stehen (lokal nachgestellt
// mit 1,5% Paketverlust, 2026-10-03). watchLiveLoss() faengt die haeufige
// Ursache ab; das hier ist das Sicherheitsnetz, falls ein Stillstand ohne
// passende Logzeile beginnt.
func watchLiveStall(session *sfuclient.Session, video sfuclient.Track, pipes *pipeline.Pipes, done <-chan struct{}) {
	if session == nil {
		return
	}
	tick := time.NewTicker(liveStallCheck)
	defer tick.Stop()
	last := pipes.VideoFrames()
	for {
		select {
		case <-done:
			return
		case <-tick.C:
		}
		now := pipes.VideoFrames()
		if now == last {
			if err := session.RequestKeyFrame(video); err != nil {
				return
			}
		}
		last = now
	}
}

// liveLossMarkers: Logzeilen des Live-ffmpeg, die bedeuten, dass dem Bild
// gerade Pakete fehlen (verloren oder zu spaet) bzw. der Decoder deshalb
// Bilder verwirft.
var liveLossMarkers = []string{
	"RTP: missed",
	"RTP: dropping old packet",
	"Keyframe missing",
	"dropping frame",
	"Discarding interframe",
	"corrupt",
}

// liveLossKeyFrameGap: hoechstens so oft ein neuer Keyframe wegen
// Paketverlust - ein Verlust kommt meist als Schwall mehrerer Logzeilen.
const liveLossKeyFrameGap = 500 * time.Millisecond

// watchLiveLoss liefert den Log-Beobachter fuer pipeline.StartLiveSource():
// sobald ffmpeg verlorene Pakete meldet, wird beim SFU ein frischer Keyframe
// angefordert.
//
// Grund: ein Browser-Zuschauer meldet jeden Verlust per NACK/PLI selbst und
// hat das Bild nach Sekundenbruchteilen wieder - ffmpeg tut das nicht. Ein
// einziges verlorenes Paket liess das VP8-Bild im HLS-Stream so bis zum
// naechsten Keyframe stehen oder zerfallen, und den schickt eine
// Bildschirmuebertragung von sich aus oft erst nach vielen Sekunden.
// Schlimmer noch beim Start: kam der erste Keyframe nicht durch, gab der
// Live-Prozess nie ein Bild aus, der Ton staute sich, bis der Prozess nicht
// mehr las - und der Raum blieb ohne ein einziges Segment.
func watchLiveLoss(session *sfuclient.Session, video sfuclient.Track) func(string) {
	if session == nil {
		return nil
	}
	var mu sync.Mutex
	var last time.Time
	return func(line string) {
		lost := false
		for _, m := range liveLossMarkers {
			if strings.Contains(line, m) {
				lost = true
				break
			}
		}
		if !lost {
			return
		}
		mu.Lock()
		due := time.Since(last) >= liveLossKeyFrameGap
		if due {
			last = time.Now()
		}
		mu.Unlock()
		if due {
			_ = session.RequestKeyFrame(video)
		}
	}
}

// liveRetryDelay: Pause vor einem neuen Live-Aufbau. Der Hub meldet "live"
// schon, bevor der Sender beim SFU produziert. Meist dauert das nur einen
// Moment, nach einem Neuaufbau der SFU-Verbindung des Senders aber auch
// laenger als die 5s in startLive(). Frueher gab HLSStream dann fuer den Rest
// der Uebertragung auf und zeigte nur das Standbild (Raum "lilhannah",
// 2026-09-28). Jetzt wird wiederholt, solange die Uebertragung laeuft.
const liveRetryDelay = 2 * time.Second

func (r *Room) scheduleLiveRetry(epoch int, delay time.Duration) {
	select {
	case <-time.After(delay):
	case <-r.quit:
		return
	}
	select {
	case r.liveRetry <- epoch:
	case <-r.quit:
	}
}

// watchLiveSession meldet, sobald sich beim SFU an den Producern etwas
// aendert, die HLSStream gerade konsumiert: der Sender hat aufgehoert
// (producer-closed), sich neu verbunden (producer-gone + new-producer), die
// Verbindung zum SFU ist weg, oder ein weiterer Producer ist dazugekommen
// (etwa der Ton, der erst nach dem Bild kam). In jedem Fall liefert die
// laufende Live-Quelle nichts Richtiges mehr - ohne neuen Aufbau bliebe das
// HLS auf einem alten Bild stehen.
func (r *Room) watchLiveSession(session *sfuclient.Session, epoch int) {
	// Meldungen aus der Zeit vor dem Consume betreffen alte Producer.
	for drained := false; !drained; {
		select {
		case <-session.Closed:
		default:
			drained = true
		}
	}
	select {
	case <-session.Closed:
	case <-session.Events:
	case <-r.quit:
		return
	}
	select {
	case r.liveRetry <- epoch:
	case <-r.quit:
	}
}

// handleLiveRetry baut die Live-Verbindung neu auf - nur, wenn die Meldung
// noch zur aktuellen Uebertragung gehoert und diese noch laeuft.
func (r *Room) handleLiveRetry(epoch int) {
	if epoch != r.liveEpoch || !r.liveOn {
		return
	}
	log.Printf("[hls %s] Live-Aufbau wird neu gestartet", r.slug)
	if r.liveSession != nil {
		r.liveSession.Close()
		r.liveSession = nil
	}
	r.startLiveHandshake()
	r.applySource()
}

var errNoVideoProducer = &roomError{"kein Video-Producer innerhalb der Frist"}

type roomError struct{ s string }

func (e *roomError) Error() string { return e.s }
