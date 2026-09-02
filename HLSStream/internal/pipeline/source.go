package pipeline

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

// NewPipes legt die zwei rohen Pipe-Paare an, die fuer die gesamte Lebenszeit
// eines Raums bestehen bleiben. Die R-Enden gehen an den einen dauerhaften
// Encoder (siehe encoder.go). Die W-Enden schreibt aber nie ein Quell-Prozess
// direkt an - dazwischen sitzt je Quelle eine eigene, kurzlebige Pipe plus
// Weiterleitung, siehe newFramePipe() unten. videoMu/audioMu serialisieren
// genau diese Weiterleitungen: bei einem Quellwechsel kann fuer einen
// winzigen Moment noch die alte parallel zur neuen laufen (das gekillte
// ffmpeg braucht ein paar Systemaufrufe, um wirklich zu sterben), und ein
// 1.3-MB-Bild ist weit groesser als das, was ein einzelner write() auf eine
// Pipe atomar schreibt - ohne Sperre koennten sich zwei solche Schreibvor-
// gaenge ineinander mischen.
type Pipes struct {
	VideoR, VideoW *os.File
	AudioR, AudioW *os.File

	videoMu, audioMu sync.Mutex
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

// newFramePipe legt fuer genau einen Quellprozess ein eigenes, privates Pipe-
// Paar an und gibt das W-Ende zurueck, das dieser Prozess als fd 3 erbt. Eine
// Hintergrund-Goroutine liest von der privaten Pipe in frameSize-grossen
// Haeppchen und reicht jedes vollstaendige Haeppchen unter dst.mu an dst
// weiter - dieselbe dauerhafte Pipe (Pipes.VideoW/AudioW), ueber die Wechsel
// hinweg alle Quellen nacheinander fuettern.
//
// Der Grund fuer diese Zwischenstation: Proc.Stop() beendet einen
// Quellprozess per SIGKILL, ohne auf ein sauberes Dateiende zu warten (siehe
// dortiger Kommentar). Schriebe dieser Prozess direkt in die dauerhafte Pipe,
// koennte ein Kill mitten in einem Bild/einer Tonprobe einen angebrochenen
// Rest dort zuruecklassen. Der eine, dauerhafte Encoder-Prozess kennt aber
// keine Bild-/Probengrenzen, nur eine feste Bytezahl je "Frame" (siehe
// encoder.args(), "-s 1280x720") - ein einziges Mal um ein paar Byte
// verschoben, bleibt diese Grenze fuer den Rest der Raum-Lebensdauer falsch:
// jedes folgende Bild wird an der falschen Stelle auseinandergeschnitten,
// gleich welche Quelle als naechstes lief. io.ReadFull hier verwirft genau
// diesen angebrochenen Rest, statt ihn weiterzureichen - lieber ein
// verlorenes Teilbild beim Wechsel als eine dauerhaft verschobene
// Bildgrenze.
func newFramePipe(dst *os.File, mu *sync.Mutex, frameSize int) (*os.File, error) {
	r, w, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	go func() {
		defer r.Close()
		buf := make([]byte, frameSize)
		for {
			if _, err := io.ReadFull(r, buf); err != nil {
				return
			}
			mu.Lock()
			_, werr := dst.Write(buf)
			mu.Unlock()
			if werr != nil {
				return
			}
		}
	}()
	return w, nil
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
// erkannt ueber eine eigene, kurzlebige "-progress"-Pipe.
//
// videoW ist das private W-Ende einer einzelnen Quelle (siehe newFramePipe())
// - der Aufrufer gibt sein eigenes Interesse daran mit dem Aufruf ab, diese
// Funktion schliesst ihre Kopie darum in jedem Fall, sobald der Kindprozess
// eine eigene hat (genau wie schon immer bei der "-progress"-Pipe pw unten):
// sonst saehe die Weiterleitungs-Goroutine in newFramePipe() nie ein
// Dateiende, wenn dieser Prozess (normal oder per SIGKILL) endet.
//
// Grund fuer den Sync selbst: ein Bild-Quellprozess braucht bis zu seinem
// ersten Bild spuerbar laenger als der zugehoerige Ton-Prozess - Datei-
// Decoder und Filtergraph-Aufbau kosten typischerweise ein paar hundert
// Millisekunden, eine triviale lavfi-Stille oder ein Audio-Codec dagegen kaum
// mehr als 30ms (gemessen). Der dauerhafte Encoder zaehlt seine Zeitstempel
// aber rein aus Bild-/Sample-Anzahl (siehe encoder.args()), nie aus
// tatsaechlicher Ankunftszeit - jeder unsynchronisierte Wechsel schreibt
// diesen Unterschied deshalb dauerhaft in den Versatz zwischen Bild und Ton
// ein, ein Stueckchen bei jedem Play/Pause und Videowechsel, das sich ueber
// die Laufzeit des Raums aufsummiert. Der Aufrufer laesst den Ton-Prozess
// deshalb erst los, wenn das Bild wirklich so weit ist - der dabei
// blockierte Aufrufer (loop() in room.go) macht nichts anderes, als was der
// ohnehin schon kurze Stillstand beim Quellwechsel erlaubt (siehe
// "Nahtloser Quellwechsel" im Architekturplan).
func startVideoSynced(name, ffmpegPath string, args []string, videoW *os.File, logPrefix string) (*Proc, error) {
	pr, pw, err := os.Pipe()
	if err != nil {
		// Kein Sync moeglich, aber kein Grund, den Quellwechsel deswegen
		// ganz scheitern zu lassen.
		proc, serr := start(name, ffmpegPath, args, []*os.File{videoW}, logPrefix)
		videoW.Close()
		return proc, serr
	}

	full := append(append([]string{}, args...), "-progress", "pipe:4", "-stats_period", "0.05")
	proc, err := start(name, ffmpegPath, full, []*os.File{videoW, pw}, logPrefix)
	videoW.Close()
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
	vw, err := newFramePipe(pipes.VideoW, &pipes.videoMu, videoFrameBytes)
	if err != nil {
		return nil, err
	}
	videoArgs := []string{
		"-hide_banner", "-loglevel", "warning",
		"-re", "-loop", "1", "-framerate", strconv.Itoa(FPS), "-i", pausedImage,
		"-vf", videoFilter,
	}
	videoArgs = append(videoArgs, videoOutputArgs()...)
	video, vErr := startVideoSynced("source-idle-v", ffmpegPath, videoArgs, vw, "[hls "+room+" idle bild]")

	aw, err := newFramePipe(pipes.AudioW, &pipes.audioMu, audioFrameBytes)
	if err != nil {
		if video != nil {
			video.Stop()
		}
		return nil, err
	}
	audioArgs := []string{
		"-hide_banner", "-loglevel", "warning",
		"-re", "-f", "lavfi", "-i", silentSource(),
	}
	audioArgs = append(audioArgs, audioOutputArgs()...)
	audio, aErr := start("source-idle-a", ffmpegPath, audioArgs, []*os.File{aw}, "[hls "+room+" idle ton]")
	aw.Close()

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

	vw, err := newFramePipe(pipes.VideoW, &pipes.videoMu, videoFrameBytes)
	if err != nil {
		return nil, err
	}
	videoArgs := []string{"-hide_banner", "-loglevel", "warning", "-re"}
	videoArgs = append(videoArgs, seek...)
	videoArgs = append(videoArgs, "-i", file, "-map", "0:v:0", "-vf", videoFilter)
	videoArgs = append(videoArgs, videoOutputArgs()...)
	video, vErr := startVideoSynced("source-file-v", ffmpegPath, videoArgs, vw, "[hls "+room+" datei bild]")

	aw, err := newFramePipe(pipes.AudioW, &pipes.audioMu, audioFrameBytes)
	if err != nil {
		if video != nil {
			video.Stop()
		}
		return nil, err
	}
	var audioArgs []string
	if hasAudio {
		audioArgs = []string{"-hide_banner", "-loglevel", "warning", "-re"}
		audioArgs = append(audioArgs, seek...)
		audioArgs = append(audioArgs, "-i", file, "-map", "0:a:0")
	} else {
		audioArgs = []string{"-hide_banner", "-loglevel", "warning", "-re", "-f", "lavfi", "-i", silentSource()}
	}
	audioArgs = append(audioArgs, audioOutputArgs()...)
	audio, aErr := start("source-file-a", ffmpegPath, audioArgs, []*os.File{aw}, "[hls "+room+" datei ton]")
	aw.Close()

	return startPair(video, audio, vErr, aErr)
}

// StartLiveSource reencoded eine laufende Bildschirmuebertragung (per SDP aus
// dem Plain-RTP-Consume beim SFU, siehe internal/sfuclient und rtp.go) in
// dieselben Pipes. videoSDP/audioSDP enthalten je nur die eine Medienzeile -
// zwei Prozesse, die dieselbe SDP mit beiden Zeilen laesen, wuerden sich um
// denselben UDP-Port streiten. Fehlt eine Tonspur (Bildschirmuebertragung
// ohne mitgeteiltes Audio), wird Stille beigemischt.
func StartLiveSource(ffmpegPath, room, videoSDP, audioSDP string, pipes *Pipes) (*SourcePair, error) {
	vw, err := newFramePipe(pipes.VideoW, &pipes.videoMu, videoFrameBytes)
	if err != nil {
		return nil, err
	}
	videoArgs := []string{
		"-hide_banner", "-loglevel", "warning",
		"-protocol_whitelist", "file,udp,rtp",
		"-analyzeduration", "1000000", "-probesize", "1000000",
		"-i", videoSDP, "-vf", videoFilter,
	}
	videoArgs = append(videoArgs, videoOutputArgs()...)
	video, vErr := startVideoSynced("source-live-v", ffmpegPath, videoArgs, vw, "[hls "+room+" live bild]")

	aw, err := newFramePipe(pipes.AudioW, &pipes.audioMu, audioFrameBytes)
	if err != nil {
		if video != nil {
			video.Stop()
		}
		return nil, err
	}
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
	audio, aErr := start("source-live-a", ffmpegPath, audioArgs, []*os.File{aw}, "[hls "+room+" live ton]")
	aw.Close()

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
