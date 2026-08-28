// Package pipeline verwaltet die ffmpeg-Prozesse eines aktiven Raums: einen
// dauerhaften Encoder, der HLS schreibt, und eine austauschbare Quelle
// (Datei/Live/Standbild), die ihn ueber zwei rohe Pipes fuettert. Siehe die
// Erklaerung "Nahtloser Quellwechsel" im Architekturplan - der Witz ist, dass
// die Pipe-Enden nie geschlossen werden, nur der Prozess, der gerade
// hineinschreibt.
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

// videoFilter bringt jede Quelle unabhaengig von ihrer Ausgangsaufloesung auf
// dasselbe 1280x720/24fps-Format - Zeile 1 sorgt fuer gerade, durch 2 teilbare
// Werte (haeufiger Absturzgrund bei mobilen Hardware-Decodern, wenn eine
// Quelle mit ungerader Kante durchgereicht wuerde).
const videoFilter = "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,fps=24"

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
