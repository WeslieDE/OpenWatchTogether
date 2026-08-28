package pipeline

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"
)

// Encoder ist der eine, dauerhaft laufende ffmpeg-Prozess je aktivem Raum,
// der aus den rohen Video-/Audio-Pipes echtes H.264/AAC macht und fortlaufend
// als HLS in outDir schreibt. Stuerzt er ab, wird er neu gestartet - dieselben
// Pipe-Enden bleiben gueltig, siehe pipeline.NewPipes().
type Encoder struct {
	ffmpegPath string
	outDir     string
	room       string
	videoR     *os.File
	audioR     *os.File

	mu      sync.Mutex
	current *Proc
	closed  bool
}

func NewEncoder(ffmpegPath, outDir, room string, videoR, audioR *os.File) (*Encoder, error) {
	if err := os.MkdirAll(outDir, 0o775); err != nil {
		return nil, fmt.Errorf("hls-ausgabeordner: %w", err)
	}
	e := &Encoder{
		ffmpegPath: ffmpegPath,
		outDir:     outDir,
		room:       room,
		videoR:     videoR,
		audioR:     audioR,
	}
	go e.supervise()
	return e, nil
}

func (e *Encoder) args() []string {
	playlist := filepath.Join(e.outDir, "index.m3u8")
	segPattern := filepath.Join(e.outDir, "seg-%05d.ts")

	// Bewusst ohne -use_wallclock_as_timestamps: die rohen Formate zaehlen
	// PTS selbst aus Bild-/Sample-Anzahl (24fps bzw. 48kHz), stur und
	// luckenlos monoton. Ein kurzer Stillstand beim Quellwechsel (siehe
	// source.go) haelt diesen Zaehler einfach an, statt - wie es mit
	// wallclock-Zeitstempeln auf einer aus Pipe-Haeppchen gelesenen Rohspur
	// tatsaechlich passierte - nicht-monotone Zeitstempel zu erzeugen, sobald
	// zwei Haeppchen sehr dicht hintereinander eintreffen.
	args := []string{
		"-hide_banner", "-loglevel", "warning",
		"-thread_queue_size", "512",
		"-f", "rawvideo", "-pix_fmt", "yuv420p",
		"-s", strconv.Itoa(Width) + "x" + strconv.Itoa(Height),
		"-r", strconv.Itoa(FPS),
		"-i", "pipe:3",

		"-thread_queue_size", "512",
		"-f", "s16le", "-ar", strconv.Itoa(SampleRate), "-ac", strconv.Itoa(Channels),
		"-i", "pipe:4",

		"-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency",
		"-profile:v", "main", "-level", "3.1", "-pix_fmt", "yuv420p",
		"-g", "48", "-keyint_min", "48", "-sc_threshold", "0",
		"-b:v", "2500k", "-maxrate", "2500k", "-bufsize", "5000k",

		"-c:a", "aac", "-b:a", "128k", "-ar", strconv.Itoa(SampleRate), "-ac", strconv.Itoa(Channels),

		"-f", "hls",
		"-hls_time", "2",
		"-hls_list_size", "8",
		"-hls_flags", "independent_segments+delete_segments+append_list",
		"-hls_segment_type", "mpegts",
		// Die Playlist verweist auf die Segmente unter /stream-seg/<raum>/ -
		// das liefert Apache direkt aus HLSStream/data aus (siehe
		// docker/watch-together.conf), getrennt von der Playlist-Route
		// /stream/<raum>.m3u8, die dieser Prozess selbst bedient.
		"-hls_base_url", "/stream-seg/" + e.room + "/",
		"-hls_segment_filename", segPattern,
		playlist,
	}
	return args
}

// supervise startet den Encoder und - stuerzt er ab, waehrend der Raum noch
// aktiv ist - startet ihn erneut. Die Pipe-Leseenden bleiben ueber alle
// Neustarts hinweg dieselben.
func (e *Encoder) supervise() {
	backoff := time.Second
	for {
		e.mu.Lock()
		if e.closed {
			e.mu.Unlock()
			return
		}
		e.mu.Unlock()

		proc, err := start("encoder", e.ffmpegPath, e.args(), []*os.File{e.videoR, e.audioR}, "[hls "+e.room+"]")
		if err != nil {
			log.Printf("[hls %s] encoder-start fehlgeschlagen: %v", e.room, err)
			time.Sleep(backoff)
			continue
		}

		e.mu.Lock()
		e.current = proc
		e.mu.Unlock()

		err = proc.Wait()

		e.mu.Lock()
		wasClosed := e.closed
		e.mu.Unlock()
		if wasClosed {
			return
		}
		log.Printf("[hls %s] encoder beendet (%v), neuer Versuch", e.room, err)
		time.Sleep(backoff)
	}
}

func (e *Encoder) Close() {
	e.mu.Lock()
	e.closed = true
	proc := e.current
	e.mu.Unlock()
	if proc != nil {
		proc.Stop()
	}
}
