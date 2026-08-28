package room

import (
	"context"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"

	"tk.weslie/watch-together-hlsstream/internal/config"
)

// Manager haelt die aktiven Raeume. "Aktiv" heisst: mindestens ein
// HLS-Zuschauer hat innerhalb von cfg.IdleTimeout die Playlist abgerufen -
// das ist bei HLS (reines Abholen per HTTP, keine dauerhafte Verbindung) das
// einzig verfuegbare Anwesenheitssignal.
type Manager struct {
	cfg config.Config

	mu    sync.Mutex
	rooms map[string]*Room
}

func NewManager(cfg config.Config) *Manager {
	return &Manager{cfg: cfg, rooms: map[string]*Room{}}
}

// Ensure joint den Raum bei Bedarf (erster Zuschauer) und erneuert immer den
// "zuletzt gesehen"-Zeitstempel. Gibt nil zurueck, wenn der Raumname vom Hub
// zuvor abgelehnt wurde (z.B. gesperrtes Wort).
func (m *Manager) Ensure(rawSlug string) *Room {
	slug := Slugify(rawSlug)
	if slug == "" {
		return nil
	}

	m.mu.Lock()
	r, ok := m.rooms[slug]
	if !ok {
		var err error
		r, err = New(m.cfg, slug)
		if err != nil {
			m.mu.Unlock()
			log.Printf("[hls] Raum %q konnte nicht gestartet werden: %v", slug, err)
			return nil
		}
		m.rooms[slug] = r
		log.Printf("[hls] Raum %q betreten", slug)
	}
	m.mu.Unlock()

	if r.Denied() {
		return nil
	}
	r.Touch()
	return r
}

// PlaylistPath, wo ffmpeg fuer diesen Raum gerade die Playlist schreibt.
func (m *Manager) PlaylistPath(slug string) string {
	return filepath.Join(m.cfg.HLSDataDir, Slugify(slug), "index.m3u8")
}

// Run raeumt in Abstaenden Raeume ab, die niemand mehr abruft.
func (m *Manager) Run(ctx context.Context) {
	t := time.NewTicker(5 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			m.reap()
		}
	}
}

func (m *Manager) reap() {
	m.mu.Lock()
	var stale []*Room
	for slug, r := range m.rooms {
		if r.Denied() || r.IdleFor() > m.cfg.IdleTimeout {
			stale = append(stale, r)
			delete(m.rooms, slug)
		}
	}
	m.mu.Unlock()

	for _, r := range stale {
		r.Close()
		dir := filepath.Join(m.cfg.HLSDataDir, r.Slug())
		if err := os.RemoveAll(dir); err != nil {
			log.Printf("[hls %s] Segmentordner konnte nicht geraeumt werden: %v", r.Slug(), err)
		}
		log.Printf("[hls] Raum %q verlassen (Leerlauf)", r.Slug())
	}
}
