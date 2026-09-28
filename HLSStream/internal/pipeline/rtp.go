package pipeline

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"tk.weslie/watch-together-hlsstream/internal/sfuclient"
)

// codecName liest den reinen Codec-Namen aus einem mediasoup-mimeType
// ("video/VP8" -> "VP8", "audio/opus" -> "opus") fuer die SDP-rtpmap-Zeile.
func codecName(mimeType string) string {
	parts := strings.SplitN(mimeType, "/", 2)
	if len(parts) != 2 {
		return mimeType
	}
	return parts[1]
}

func sdpHeader() string {
	var b strings.Builder
	b.WriteString("v=0\r\n")
	b.WriteString("o=- 0 0 IN IP4 127.0.0.1\r\n")
	b.WriteString("s=HLSStream\r\n")
	b.WriteString("c=IN IP4 127.0.0.1\r\n")
	b.WriteString("t=0 0\r\n")
	return b.String()
}

// WriteLiveSDP baut die SDP-Datei fuer die Live-Quelle: Bild und - falls
// vorhanden - Ton in derselben Datei, damit ein einziger ffmpeg-Prozess beide
// liest und ihre Zeitstempel gemeinsam fuehrt (siehe StartLiveSource() in
// source.go). Jede Spur hat ihren eigenen Port, ffmpeg haelt sie darueber
// auseinander.
func WriteLiveSDP(dir string, video sfuclient.Track, audio *sfuclient.Track) (string, error) {
	var b strings.Builder
	b.WriteString(sdpHeader())
	fmt.Fprintf(&b, "m=video %d RTP/AVP %d\r\n", video.Port, video.PayloadType)
	fmt.Fprintf(&b, "a=rtpmap:%d %s/%d\r\n", video.PayloadType, codecName(video.MimeType), video.ClockRate)
	if audio != nil {
		fmt.Fprintf(&b, "m=audio %d RTP/AVP %d\r\n", audio.Port, audio.PayloadType)
		fmt.Fprintf(&b, "a=rtpmap:%d %s/%d/%d\r\n", audio.PayloadType, codecName(audio.MimeType), audio.ClockRate, audio.Channels)
	}
	return writeFile(dir, "live.sdp", b.String())
}

func writeFile(dir, name, content string) (string, error) {
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(content), 0o664); err != nil {
		return "", err
	}
	return path, nil
}
