package pipeline

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// NewPipes legt die zwei rohen Pipe-Paare an, die fuer die gesamte Lebenszeit
// eines Raums bestehen bleiben. Die W-Enden gehen an wechselnde Quell-
// Prozesse, die R-Enden immer an denselben Encoder - siehe encoder.go.
type Pipes struct {
	VideoR, VideoW *os.File
	AudioR, AudioW *os.File
}

func NewPipes() (*Pipes, error) {
	vr, vw, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	ar, aw, err := os.Pipe()
	if err != nil {
		vr.Close()
		vw.Close()
		return nil, err
	}
	return &Pipes{VideoR: vr, VideoW: vw, AudioR: ar, AudioW: aw}, nil
}

func (p *Pipes) Close() {
	p.VideoR.Close()
	p.VideoW.Close()
	p.AudioR.Close()
	p.AudioW.Close()
}

// SourcePair sind die zwei Prozesse, die gerade Bild bzw. Ton in die Pipes
// schreiben - getrennt gehalten, siehe die Begruendung bei videoOutputArgs().
type SourcePair struct {
	Video, Audio *Proc
}

func (sp *SourcePair) Stop() {
	if sp == nil {
		return
	}
	if sp.Video != nil {
		sp.Video.Stop()
	}
	if sp.Audio != nil {
		sp.Audio.Stop()
	}
}

func startPair(video, audio *Proc, videoErr, audioErr error) (*SourcePair, error) {
	if videoErr != nil || audioErr != nil {
		if video != nil {
			video.Stop()
		}
		if audio != nil {
			audio.Stop()
		}
		if videoErr != nil {
			return nil, videoErr
		}
		return nil, audioErr
	}
	return &SourcePair{Video: video, Audio: audio}, nil
}

// readySignalTimeout: Sicherheitsnetz fuer startVideoSynced() unten, falls
// "-progress" aus irgendeinem Grund nie meldet - dann startet der Ton-
// Prozess trotzdem, nur eben ohne den Sync-Vorteil. Grosszuegig bemessen:
// selbst das langsamste gemessene Bild (Datei-Decoder mit Sprungstelle)
// braucht keine 300ms bis zu seinem ersten Bild.
const readySignalTimeout = 2 * time.Second

// startVideoSynced startet den Bild-Prozess wie start(), blockiert aber
// zusaetzlich, bis ffmpeg sein erstes Bild tatsaechlich ausgegeben hat -
// erkannt ueber eine eigene, kurzlebige "-progress"-Pipe, die grosse
// Bilddaten-Pipe (videoW) bleibt davon unberuehrt.
//
// Grund: ein Bild-Quellprozess braucht bis zu seinem ersten Bild spuerbar
// laenger als der zugehoerige Ton-Prozess - Datei-Decoder und Filtergraph-
// Aufbau kosten typischerweise ein paar hundert Millisekunden, eine triviale
// lavfi-Stille oder ein Audio-Codec dagegen kaum mehr als 30ms (gemessen).
// Der dauerhafte Encoder zaehlt seine Zeitstempel aber rein aus Bild-/
// Sample-Anzahl (siehe encoder.args()), nie aus tatsaechlicher Ankunftszeit -
// jeder unsynchronisierte Wechsel schreibt diesen Unterschied deshalb
// dauerhaft in den Versatz zwischen Bild und Ton ein, ein Stueckchen bei
// jedem Play/Pause und Videowechsel, das sich ueber die Laufzeit des Raums
// aufsummiert. Der Aufrufer laesst den Ton-Prozess deshalb erst los, wenn
// das Bild wirklich so weit ist - der dabei blockierte Aufrufer (loop() in
// room.go) macht nichts anderes, als was der ohnehin schon kurze Stillstand
// beim Quellwechsel erlaubt (siehe "Nahtloser Quellwechsel" im Architekturplan).
func startVideoSynced(name, ffmpegPath string, args []string, videoW *os.File, logPrefix string) (*Proc, error) {
	pr, pw, err := os.Pipe()
	if err != nil {
		// Kein Sync moeglich, aber kein Grund, den Quellwechsel deswegen
		// ganz scheitern zu lassen.
		return start(name, ffmpegPath, args, []*os.File{videoW}, logPrefix)
	}

	full := append(append([]string{}, args...), "-progress", "pipe:4", "-stats_period", "0.05")
	proc, err := start(name, ffmpegPath, full, []*os.File{videoW, pw}, logPrefix)
	pw.Close()
	if err != nil {
		pr.Close()
		return proc, err
	}

	ready := make(chan struct{})
	go func() {
		defer pr.Close()
		sc := bufio.NewScanner(pr)
		sc.Buffer(make([]byte, 0, 4096), 1<<16)
		signaled := false
		for sc.Scan() {
			if !signaled {
				signaled = true
				close(ready)
			}
		}
		// Der Prozess starb, bevor er ueberhaupt eine Zeile gemeldet hat -
		// nicht die volle Frist verschenken, das erledigt gleich ohnehin der
		// Fehlerpfad in room.watchSourceExit().
		if !signaled {
			close(ready)
		}
	}()

	select {
	case <-ready:
	case <-time.After(readySignalTimeout):
	}
	return proc, nil
}

// StartIdleSource zeigt das Standbild (assets/VideoPaused.png, oder das per
// Env konfigurierte Bild), solange gerade nichts laeuft oder pausiert ist -
// mit Stille als Tonspur, damit die Pipes nie leerlaufen.
func StartIdleSource(ffmpegPath, room, pausedImage string, pipes *Pipes) (*SourcePair, error) {
	videoArgs := []string{
		"-hide_banner", "-loglevel", "warning",
		"-re", "-loop", "1", "-framerate", strconv.Itoa(FPS), "-i", pausedImage,
		"-vf", videoFilter,
	}
	videoArgs = append(videoArgs, videoOutputArgs()...)
	video, vErr := startVideoSynced("source-idle-v", ffmpegPath, videoArgs, pipes.VideoW, "[hls "+room+" idle bild]")

	audioArgs := []string{
		"-hide_banner", "-loglevel", "warning",
		"-re", "-f", "lavfi", "-i", silentSource(),
	}
	audioArgs = append(audioArgs, audioOutputArgs()...)
	audio, aErr := start("source-idle-a", ffmpegPath, audioArgs, []*os.File{pipes.AudioW}, "[hls "+room+" idle ton]")

	return startPair(video, audio, vErr, aErr)
}

// StartFileSource spielt eine lokale Videodatei ab der angegebenen Position
// in Echtzeit ab (-re), damit die Pipes im Takt der tatsaechlichen
// Wiedergabe gefuettert werden statt so schnell wie moeglich leerzulaufen.
func StartFileSource(ffmpegPath, room, file string, startSeconds float64, hasAudio bool, pipes *Pipes) (*SourcePair, error) {
	seek := []string{}
	if startSeconds > 0 {
		seek = []string{"-ss", strconv.FormatFloat(startSeconds, 'f', 3, 64)}
	}

	videoArgs := []string{"-hide_banner", "-loglevel", "warning", "-re"}
	videoArgs = append(videoArgs, seek...)
	videoArgs = append(videoArgs, "-i", file, "-map", "0:v:0", "-vf", videoFilter)
	videoArgs = append(videoArgs, videoOutputArgs()...)
	video, vErr := startVideoSynced("source-file-v", ffmpegPath, videoArgs, pipes.VideoW, "[hls "+room+" datei bild]")

	var audioArgs []string
	if hasAudio {
		audioArgs = []string{"-hide_banner", "-loglevel", "warning", "-re"}
		audioArgs = append(audioArgs, seek...)
		audioArgs = append(audioArgs, "-i", file, "-map", "0:a:0")
	} else {
		audioArgs = []string{"-hide_banner", "-loglevel", "warning", "-re", "-f", "lavfi", "-i", silentSource()}
	}
	audioArgs = append(audioArgs, audioOutputArgs()...)
	audio, aErr := start("source-file-a", ffmpegPath, audioArgs, []*os.File{pipes.AudioW}, "[hls "+room+" datei ton]")

	return startPair(video, audio, vErr, aErr)
}

// StartLiveSource reencoded eine laufende Bildschirmuebertragung (per SDP aus
// dem Plain-RTP-Consume beim SFU, siehe internal/sfuclient und rtp.go) in
// dieselben Pipes. videoSDP/audioSDP enthalten je nur die eine Medienzeile -
// zwei Prozesse, die dieselbe SDP mit beiden Zeilen laesen, wuerden sich um
// denselben UDP-Port streiten. Fehlt eine Tonspur (Bildschirmuebertragung
// ohne mitgeteiltes Audio), wird Stille beigemischt.
func StartLiveSource(ffmpegPath, room, videoSDP, audioSDP string, pipes *Pipes) (*SourcePair, error) {
	videoArgs := []string{
		"-hide_banner", "-loglevel", "warning",
		"-protocol_whitelist", "file,udp,rtp",
		"-analyzeduration", "1000000", "-probesize", "1000000",
		"-i", videoSDP, "-vf", videoFilter,
	}
	videoArgs = append(videoArgs, videoOutputArgs()...)
	video, vErr := startVideoSynced("source-live-v", ffmpegPath, videoArgs, pipes.VideoW, "[hls "+room+" live bild]")

	var audioArgs []string
	if audioSDP != "" {
		audioArgs = []string{
			"-hide_banner", "-loglevel", "warning",
			"-protocol_whitelist", "file,udp,rtp",
			"-analyzeduration", "1000000", "-probesize", "1000000",
			"-i", audioSDP,
		}
	} else {
		audioArgs = []string{"-hide_banner", "-loglevel", "warning", "-re", "-f", "lavfi", "-i", silentSource()}
	}
	audioArgs = append(audioArgs, audioOutputArgs()...)
	audio, aErr := start("source-live-a", ffmpegPath, audioArgs, []*os.File{pipes.AudioW}, "[hls "+room+" live ton]")

	return startPair(video, audio, vErr, aErr)
}

func silentSource() string {
	return fmt.Sprintf("anullsrc=r=%d:cl=stereo", SampleRate)
}

// HasAudioStream fragt ffprobe, ob die Datei eine Tonspur hat - dieselbe
// Absicherung, mit der auch der Rest der App (src/Probe.php) schon
// vorsichtig gegenueber fremden Dateien ist.
func HasAudioStream(ffprobePath, file string) bool {
	out, err := exec.Command(ffprobePath,
		"-v", "error",
		"-select_streams", "a",
		"-show_entries", "stream=index",
		"-of", "csv=p=0",
		file,
	).Output()
	if err != nil {
		return false
	}
	return strings.TrimSpace(string(out)) != ""
}
