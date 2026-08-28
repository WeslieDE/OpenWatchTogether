package pipeline

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
)

// HoldDuration ist die Laenge des vorgerenderten Standbild-Segments aus
// RenderHold() - dieselbe Groessenordnung wie ein echtes Segment (siehe
// "-hls_time 2" in encoder.args()), damit ein Player, der es entgegennimmt,
// sich wie bei jedem anderen Segment verhaelt.
const HoldDuration = 2.0

// RenderHold rendert einmalig, beim Start des Dienstes, ein einzelnes
// eigenstaendiges HLS-Segment mit dem Standbild - in denselben Codec-
// Parametern wie der eigentliche Encoder (siehe encoder.args()), damit der
// Wechsel auf den echten Stream keinen Bruch fuer den Decoder macht.
//
// Grund fuer die Existenz: ein frisch betretener Raum braucht - der Reihe
// nach: Verbindungsaufbau zum Hub, Start des passenden Quell-Prozesses, ein
// volles GOP (2s) durch den Encoder - spuerbar laenger als viele HLS-Player
// auf das allererste Segment warten, bevor sie den Ladevorgang als
// fehlgeschlagen abbrechen. httpapi.Server liefert dieses eine Segment
// deshalb sofort aus, solange der jeweilige Raum noch kein eigenes hat.
//
// Anders als die dauerhaften Quell-Prozesse in source.go ist das hier ein
// einzelner, endlicher ffmpeg-Aufruf ohne Pipes: Bild und Ton laufen bewusst
// im selben Prozess, weil nichts fortlaufend gemuxt wird, bei dem ihre
// Zeitstempel auseinanderlaufen koennten (der Grund fuer die Trennung
// anderswo, siehe videoOutputArgs()).
func RenderHold(ffmpegPath, pausedImage string) ([]byte, error) {
	dir, err := os.MkdirTemp("", "hls-hold-*")
	if err != nil {
		return nil, fmt.Errorf("temp-ordner: %w", err)
	}
	defer os.RemoveAll(dir)
	out := filepath.Join(dir, "hold.ts")

	args := []string{
		"-hide_banner", "-loglevel", "warning", "-y",
		"-loop", "1", "-framerate", strconv.Itoa(FPS), "-i", pausedImage,
		"-f", "lavfi", "-i", silentSource(),
		"-t", strconv.FormatFloat(HoldDuration, 'f', -1, 64),
		"-vf", videoFilter,
		"-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency",
		"-profile:v", "main", "-level", "3.1", "-pix_fmt", "yuv420p",
		"-g", "48", "-keyint_min", "48", "-sc_threshold", "0",
		"-b:v", "2500k", "-maxrate", "2500k", "-bufsize", "5000k",
		"-c:a", "aac", "-b:a", "128k", "-ar", strconv.Itoa(SampleRate), "-ac", strconv.Itoa(Channels),
		"-f", "mpegts",
		out,
	}

	cmd := exec.Command(ffmpegPath, args...)
	combined, err := cmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("ffmpeg: %w: %s", err, combined)
	}

	return os.ReadFile(out)
}
