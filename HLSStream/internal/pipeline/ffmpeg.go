// Package pipeline verwaltet die ffmpeg-Prozesse eines aktiven Raums: einen
// dauerhaften Encoder, der HLS schreibt, und eine austauschbare Quelle
// (Datei/Live/Standbild), die ihn ueber zwei rohe Pipes fuettert. Siehe die
// Erklaerung "Nahtloser Quellwechsel" im Architekturplan - der Witz ist, dass
// die dauerhaften Pipe-Enden (Pipes.VideoW/AudioW) nie geschlossen werden,
// nur der Prozess, der gerade hineinschreibt. Kein Quellprozess schreibt
// dort aber direkt hinein - siehe newFramePipe() in source.go und den
// Kommentar dort, warum dazwischen noch eine byte-genaue Weiterleitung
// sitzt.
package pipeline

import (
	"bufio"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"strconv"
	"strings"
)

const (
	Width      = 1280
	Height     = 720
	FPS        = 24
	SampleRate = 48000
	Channels   = 2
)

// videoFrameBytes/audioFrameBytes: die Bytezahl, die ein einzelnes Bild bzw.
// eine einzelne Sample-Gruppe in den rohen Formaten belegt, die zwischen
// Quelle und Encoder fliessen (yuv420p bzw. s16le). encoder.args() liest
// beide Pipes ohne jede Framing-Information, nur ueber diese feste Bytezahl
// je "Frame" (siehe "-s 1280x720" dort) - newFramePipe() in source.go nutzt
// dieselben Konstanten, um niemals einen angebrochenen Rest weiterzureichen.
const (
	videoFrameBytes = Width * Height * 3 / 2 // yuv420p: volle Y-Ebene + halbe U/V
	audioFrameBytes = Channels * 2           // s16le: 2 Byte je Kanal und Sample
)

// videoFilter bringt jede Quelle unabhaengig von ihrer Ausgangsaufloesung auf
// dasselbe 1280x720/24fps-Format - Zeile 1 sorgt fuer gerade, durch 2 teilbare
// Werte (haeufiger Absturzgrund bei mobilen Hardware-Decodern, wenn eine
// Quelle mit ungerader Kante durchgereicht wuerde). "eval=frame" bei pad ist
// Pflicht, kein Kosmetik-Detail: ohne das wertet ffmpeg die x/y-Ausdruecke
// (ow-iw)/2 bzw. (oh-ih)/2 nur einmal beim Aufbau des Filtergraphen aus. Bei
// einer laufenden Live-Quelle (StartLiveSource laesst dieses Filter fuer die
// gesamte Dauer der Uebertragung leben) aendert sich das Seitenverhaeltnis
// aber mitten im Stream, z.B. wenn der Sender von einer 9:16- auf eine
// 16:9-Quelle wechselt - scale liefert dann ein anders grosses Bild, pad
// klebt es aber weiter an die fuer das alte Seitenverhaeltnis berechnete,
// nun falsche Position. Das ist keine kurze Dekodier-Stoerung, die sich am
// naechsten Keyframe von selbst behebt, sondern ein dauerhaft falsch
// zusammengesetztes Bild, bis der Prozess neu startet. "eval=frame" laesst
// pad x/y bei jedem einzelnen Bild neu berechnen.
const videoFilter = "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black:eval=frame,fps=24"

// videoOutputArgs/audioOutputArgs haengen an ein Quell-Kommando seinen
// Ausgang: rohes Bild bzw. roher Ton auf fd 3 (die einzige ExtraFiles-Datei
// dieses Prozesses). Bild und Ton laufen bewusst in getrennten ffmpeg-
// Prozessen statt in einem mit zwei -re-getakteten Eingaengen und zwei
// Ausgaengen - einfacher pro Prozess, und die eigentliche Ursache fuer nicht-
// monotone Zeitstempel lag ohnehin auf der Encoder-Seite (siehe der
// Kommentar bei encoder.args()).
func videoOutputArgs() []string {
	return []string{"-pix_fmt", "yuv420p", "-f", "rawvideo", "pipe:3"}
}

func audioOutputArgs() []string {
	return []string{"-f", "s16le", "-ar", strconv.Itoa(SampleRate), "-ac", strconv.Itoa(Channels), "pipe:3"}
}

// Proc ist ein laufender ffmpeg-Prozess mit der einen Pipe, die er als fd 3
// geerbt hat. Eine einzige Hintergrund-Goroutine wartet auf sein Ende und
// legt das Ergebnis in done ab - sowohl fuer den normalen Fall (encoder.go
// wartet blockierend darauf) als auch dafuer, dass ein Aufrufer merkt, wenn
// eine Quelle unerwartet frueh verendet (siehe room.watchSourceExit()), etwa
// weil sie ueber das Ende einer Datei hinaus angesetzt wurde.
type Proc struct {
	cmd  *exec.Cmd
	name string
	done chan error
}

func start(name, ffmpegPath string, args []string, extra []*os.File, logPrefix string) (*Proc, error) {
	cmd := exec.Command(ffmpegPath, args...)
	cmd.ExtraFiles = extra
	cmd.Stdin = nil

	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, fmt.Errorf("%s: stderr-pipe: %w", name, err)
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("%s: start: %w", name, err)
	}
	go logLines(logPrefix, stderr)

	p := &Proc{cmd: cmd, name: name, done: make(chan error, 1)}
	go func() { p.done <- cmd.Wait() }()
	return p, nil
}

func logLines(prefix string, r io.Reader) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 4096), 1<<20)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		log.Printf("%s %s", prefix, line)
	}
}

// Done liefert das Prozessende - genau einmal lesbar, siehe start().
func (p *Proc) Done() <-chan error { return p.done }

// Wait blockiert, bis der Prozess beendet ist. Dieselbe Auskunft wie Done(),
// nur bequem fuer einen Aufrufer, der ohnehin nichts anderes nebenbei tut
// (siehe encoder.supervise()).
func (p *Proc) Wait() error { return <-p.done }

// Stop beendet den Prozess sofort (SIGKILL) - Quell-Prozesse schreiben nur
// rohe Frames ohne eigenen Dateiabschluss, ein hartes Ende spart die paar
// hundert Millisekunden, die ein Wechsel sonst laenger braeuchte. Das
// eigentliche Aufraeumen (die start()-Goroutine wartet ohnehin schon auf
// cmd.Wait()) muss hier nicht mehr angestossen werden.
func (p *Proc) Stop() {
	if p.cmd.Process == nil {
		return
	}
	_ = p.cmd.Process.Kill()
}
