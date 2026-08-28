// HLSStream ist ein eigenstaendiger Dienst, der Watch-Together-Raeume unter
// einer festen URL (/stream/<raum>.m3u8) als HLS anbietet. Er klinkt sich pro
// aktivem Raum wie ein normaler Browser-Client per WebSocket ein (siehe
// internal/hub), liest bei einer laufenden Bildschirmuebertragung zusaetzlich
// per Plain-RTP beim SFU mit (internal/sfuclient) und encodiert alles
// durchgehend nach H.264/AAC (internal/pipeline). Siehe docs/hlsstream.md.
package main

import (
	"context"
	"log"
	"net"
	"net/http"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"tk.weslie/watch-together-hlsstream/internal/config"
	"tk.weslie/watch-together-hlsstream/internal/httpapi"
	"tk.weslie/watch-together-hlsstream/internal/pipeline"
	"tk.weslie/watch-together-hlsstream/internal/room"
)

func main() {
	cfg := config.Load()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// Einmal fuer die gesamte Laufzeit: das Standbild-Segment, das ein
	// frischer Raum sofort bekommt, waehrend sein eigener Encoder noch am
	// allerersten echten Segment sitzt (siehe pipeline.RenderHold()).
	// Schlaegt das fehl, laeuft der Dienst trotzdem weiter - servePlaylist
	// faellt dann auf das alte "503, bitte gleich nochmal"-Verhalten zurueck.
	hold, err := pipeline.RenderHold(cfg.FFmpegPath, cfg.PausedImage)
	if err != nil {
		log.Printf("[hls] Standbild-Segment konnte nicht vorgerendert werden: %v", err)
	}

	manager := room.NewManager(cfg)
	go manager.Run(ctx)

	srv := &http.Server{
		Addr:              net.JoinHostPort(cfg.HTTPHost, strconv.Itoa(cfg.HTTPPort)),
		Handler:           httpapi.New(manager, hold).Handler(),
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()

	log.Printf("[hls] Playlist-Server auf %s", srv.Addr)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("[hls] Server beendet: %v", err)
	}
}
