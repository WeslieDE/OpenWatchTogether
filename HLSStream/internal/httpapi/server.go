// Package httpapi ist der einzige HTTP-Eingang von HLSStream: die
// Playlist-Route. Die eigentlichen .ts-Segmente liefert Apache direkt aus dem
// Dateisystem (Alias /stream -> HLSStream/data, siehe
// docker/watch-together.conf) - dieser Server sieht sie nie. Dadurch bleibt
// der Fussabdruck klein, egal wie viele HLS-Zuschauer zusehen: pro
// Wiedergabe kommt hier nur ein Playlist-Request alle paar Sekunden an. Die
// einzige Ausnahme ist das vorgerenderte Standbild-Segment (serveHold()
// unten) - das laeuft bewusst hier durch, weil es nur kurz nach jedem
// Raumbeitritt gebraucht wird, nicht dauerhaft pro Zuschauer.
package httpapi

import (
	"math"
	"net/http"
	"os"
	"strconv"
	"strings"

	"tk.weslie/watch-together-hlsstream/internal/pipeline"
	"tk.weslie/watch-together-hlsstream/internal/room"
)

type Server struct {
	manager *room.Manager
	hold    []byte
}

// New: hold ist das vorgerenderte Standbild-Segment aus pipeline.RenderHold()
// - leer, wenn es beim Start nicht gerendert werden konnte, dann faellt
// servePlaylist auf das alte Verhalten (503 + Retry-After) zurueck.
func New(manager *room.Manager, hold []byte) *Server {
	return &Server{manager: manager, hold: hold}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/stream/", s.servePlaylist)
	if len(s.hold) > 0 {
		// Spezifischer als das "/stream/"-Muster oben, gewinnt also im Mux.
		mux.HandleFunc("/stream/_hold.ts", s.serveHold)
	}
	return mux
}

func (s *Server) servePlaylist(w http.ResponseWriter, req *http.Request) {
	name := strings.TrimPrefix(req.URL.Path, "/stream/")
	if !strings.HasSuffix(name, ".m3u8") {
		http.NotFound(w, req)
		return
	}
	slug := strings.TrimSuffix(name, ".m3u8")
	if slug == "" {
		http.NotFound(w, req)
		return
	}

	r := s.manager.Ensure(slug)
	if r == nil {
		http.Error(w, "Raumname nicht erlaubt", http.StatusForbidden)
		return
	}

	path := s.manager.PlaylistPath(slug)
	data, err := os.ReadFile(path)
	if err != nil {
		// Der Encoder braucht nach dem Beitritt ein paar Sekunden bis zum
		// ersten echten Segment (Hub-Handshake, Start des Quell-Prozesses,
		// ein volles GOP). Ohne vorgerendertes Standbild bleibt nur der
		// Verweis auf Wiederholung - manche Player brechen dabei aber ab,
		// bevor der echte Stream steht, siehe pipeline.RenderHold().
		if len(s.hold) == 0 {
			w.Header().Set("Retry-After", "1")
			http.Error(w, "Stream wird vorbereitet", http.StatusServiceUnavailable)
			return
		}
		s.writeHoldPlaylist(w)
		return
	}

	w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	_, _ = w.Write(data)
}

// writeHoldPlaylist gibt eine eigenstaendige Ein-Segment-Playlist auf das
// Standbild zurueck - ohne ENDLIST, weil danach an derselben URL der echte,
// laufende Stream folgt. Der Player fragt sie beim naechsten Poll ohnehin
// erneut ab und bekommt dann ganz normal die echte Playlist von ffmpeg.
func (s *Server) writeHoldPlaylist(w http.ResponseWriter) {
	target := strconv.Itoa(int(math.Ceil(pipeline.HoldDuration)))
	playlist := "#EXTM3U\n" +
		"#EXT-X-VERSION:3\n" +
		"#EXT-X-TARGETDURATION:" + target + "\n" +
		"#EXT-X-MEDIA-SEQUENCE:0\n" +
		"#EXT-X-INDEPENDENT-SEGMENTS\n" +
		"#EXTINF:" + strconv.FormatFloat(pipeline.HoldDuration, 'f', 3, 64) + ",\n" +
		"_hold.ts\n"

	w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Content-Length", strconv.Itoa(len(playlist)))
	_, _ = w.Write([]byte(playlist))
}

func (s *Server) serveHold(w http.ResponseWriter, req *http.Request) {
	w.Header().Set("Content-Type", "video/mp2t")
	// Immer dasselbe Standbild, fuer die gesamte Laufzeit des Prozesses -
	// darf der Player/ein zwischengeschalteter Proxy ruhig eine Weile behalten.
	w.Header().Set("Cache-Control", "public, max-age=3600, immutable")
	w.Header().Set("Content-Length", strconv.Itoa(len(s.hold)))
	_, _ = w.Write(s.hold)
}
