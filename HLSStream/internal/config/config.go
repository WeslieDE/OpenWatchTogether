// Package config liest die Einstellungen fuer HLSStream aus Umgebungsvariablen,
// nach demselben Muster wie src/Config.php und sfu/server.js: alles hat eine
// vernuenftige Vorgabe fuer den Betrieb im Docker-Container, nichts muss dort
// angefasst werden.
package config

import (
	"os"
	"strconv"
	"time"
)

// PeerName ist der feste Name, unter dem sich der Dienst in jedem Raum
// anmeldet - siehe Hub::join()/Room::freeName() in src/Ws/Hub.php.
const PeerName = "HLSStream"

type Config struct {
	// Interner Hub-Prozess (ws/server.php). Im Container lauscht er laut
	// Dockerfile-ENV auf 127.0.0.1:8081 - HLSStream verbindet sich direkt
	// dorthin, ohne Umweg ueber Apache.
	HubHost string
	HubPort int

	// Interner SFU-Prozess (sfu/server.js), gleiches Muster.
	SFUHost string
	SFUPort int

	// WT_DATA_DIR - dort liegen die Raum-Videos unter /media/<roomId>/...,
	// siehe Db::toItem() in src/Db.php. HLSStream liest sie direkt von der
	// Platte statt per HTTP.
	DataDir string

	// Eigener HTTP-Server, der ausschliesslich die Playlist ausliefert -
	// die Segmente bedient Apache direkt aus HLSDataDir.
	HTTPHost string
	HTTPPort int

	// Wie lange ein Raum ohne Playlist-Abruf aktiv bleibt, bevor HLSStream
	// ihn wieder verlaesst.
	IdleTimeout time.Duration

	FFmpegPath  string
	FFprobePath string

	// Wohin ffmpeg die Playlist/Segmente je Raum schreibt.
	HLSDataDir string

	// Standbild, wenn gerade nichts laeuft/pausiert ist.
	PausedImage string
}

func Load() Config {
	return Config{
		HubHost:     env("WT_WS_HOST", "127.0.0.1"),
		HubPort:     envInt("WT_WS_PORT", 8081),
		SFUHost:     env("WT_SFU_WS_HOST", "127.0.0.1"),
		SFUPort:     envInt("WT_SFU_WS_PORT", 8082),
		DataDir:     env("WT_DATA_DIR", "/data"),
		HTTPHost:    env("WT_HLS_HTTP_HOST", "127.0.0.1"),
		HTTPPort:    envInt("WT_HLS_HTTP_PORT", 8083),
		IdleTimeout: time.Duration(envInt("WT_HLS_IDLE_SECONDS", 30)) * time.Second,
		FFmpegPath:  env("WT_HLS_FFMPEG", "ffmpeg"),
		FFprobePath: env("WT_HLS_FFPROBE", "ffprobe"),
		HLSDataDir:  env("WT_HLS_DATA_DIR", "/var/www/html/HLSStream/data"),
		PausedImage: env("WT_HLS_PAUSED_IMAGE", "/var/www/html/HLSStream/assets/VideoPaused.png"),
	}
}

func env(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	v, ok := os.LookupEnv(key)
	if !ok || v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return fallback
	}
	return n
}
