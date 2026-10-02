package pipeline

import (
	"bufio"
	"bytes"
	"strconv"
	"strings"
)

// HoldEntry: der Playlist-Eintrag fuer das Standbild-Segment aus
// RenderHold() - in der Ersatz-Playlist (httpapi.writeHoldPlaylist) wie in
// der echten (RewritePlaylist()) immer derselbe, unter Sequenznummer 0. Die
// URL ist relativ zur Playlist-Route /stream/<raum>.m3u8.
func HoldEntry() string {
	return "#EXTINF:" + strconv.FormatFloat(HoldDuration, 'f', 3, 64) + ",\n_hold.ts\n"
}

// RewritePlaylist macht aus der von ffmpeg geschriebenen index.m3u8 die
// Playlist, die Player zu sehen bekommen. Ziel: wer in den ersten Sekunden
// nach dem Raumbeitritt nur das Standbild-Segment bekommen hat (Ersatz-
// Playlist, Segment 0 = _hold.ts), sieht danach eine Fortsetzung genau
// dieser Playlist - ohne Widerspruch, ohne Bruch, ohne Zeitsprung.
//
//   - Segment 0 bleibt fuer immer _hold.ts: ffmpegs eigenes erstes Segment
//     wird durch das Standbild ersetzt. Beide haben exakt dasselbe Timing
//     (gleiche Codec-Parameter, gleiche 2s, gleiche Startverschiebung des
//     MPEG-TS-Muxers, siehe RenderHold()), seg-00001 schliesst also
//     lueckenlos an beide an. Frueher nannte ffmpegs Playlist Segment 0
//     "seg-00000.ts" mit vorangestelltem EXT-X-DISCONTINUITY - dieselbe
//     Nummer fuer zwei verschiedene Segmente, gemessen gegen vrtogether.de
//     am 2026-10-02.
//   - Zwei Zwischenversuche sind daran gescheitert (2c2e0a9, d35cf2d): Das
//     Standbild sofort fallen zu lassen haengte VLC auf (es wartet beim
//     Live-Start auf genug Puffer und bleibt fuer immer stehen, wenn das
//     Segment verschwindet, auf dem es steht). Ein DISCONTINUITY oder auch
//     nur 20-50ms rueckwaerts laufende Zeitstempel beim Uebergang liessen
//     Wines MediaFoundation-Nachbau (AVPro in VRChat unter Proton) mit einer
//     Assertion in mf/session.c abstuerzen.
//   - ffmpegs eigene DISCONTINUITY-Tags (append_list setzt eines an jeden
//     Laufbeginn, auch den ersten) werden verworfen. Ein echter Bruch steht
//     nur vor Segmenten, mit denen ein Encoder-Neustart begonnen hat
//     (runStarts, siehe Encoder.supervise()) - ausser Segment 0. Fuer
//     Brueche, die schon aus dem Fenster gefallen sind, zaehlt
//     EXT-X-DISCONTINUITY-SEQUENCE weiter; ffmpeg selbst schreibt das nie,
//     die Discontinuity-Sequenz liefe sonst zurueck.
func RewritePlaylist(src []byte, runStarts []int) []byte {
	isBreak := make(map[int]bool, len(runStarts))
	for _, n := range runStarts {
		if n != 0 {
			isBreak[n] = true
		}
	}

	mediaSeq := 0
	sc := bufio.NewScanner(bytes.NewReader(src))
	for sc.Scan() {
		if v, ok := strings.CutPrefix(strings.TrimSpace(sc.Text()), "#EXT-X-MEDIA-SEQUENCE:"); ok {
			mediaSeq, _ = strconv.Atoi(v)
			break
		}
	}

	discSeq := 0
	for n := range isBreak {
		if n < mediaSeq {
			discSeq++
		}
	}

	var out bytes.Buffer
	next := mediaSeq // ffmpeg-Nummer des naechsten Segments in der Liste
	skipURI := false
	sc = bufio.NewScanner(bytes.NewReader(src))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		switch {
		case line == "":
			continue
		case line == "#EXT-X-DISCONTINUITY":
			continue
		case strings.HasPrefix(line, "#EXT-X-DISCONTINUITY-SEQUENCE:"):
			continue
		case strings.HasPrefix(line, "#EXT-X-MEDIA-SEQUENCE:"):
			out.WriteString(line + "\n")
			if discSeq > 0 {
				out.WriteString("#EXT-X-DISCONTINUITY-SEQUENCE:" + strconv.Itoa(discSeq) + "\n")
			}
			continue
		case strings.HasPrefix(line, "#EXTINF:"):
			if isBreak[next] {
				out.WriteString("#EXT-X-DISCONTINUITY\n")
			}
			if next == 0 {
				out.WriteString(HoldEntry())
				skipURI = true
				continue
			}
		case !strings.HasPrefix(line, "#"):
			next++
			if skipURI {
				skipURI = false
				continue
			}
		}
		out.WriteString(line + "\n")
	}
	return out.Bytes()
}

// nextSegmentNumber liest aus einer bestehenden ffmpeg-Playlist, mit welcher
// Nummer ffmpeg (dank append_list) beim naechsten Start weiterzaehlt - 0,
// wenn es noch keine gibt.
func nextSegmentNumber(src []byte) int {
	seq, count := 0, 0
	sc := bufio.NewScanner(bytes.NewReader(src))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if v, ok := strings.CutPrefix(line, "#EXT-X-MEDIA-SEQUENCE:"); ok {
			seq, _ = strconv.Atoi(v)
		} else if line != "" && !strings.HasPrefix(line, "#") {
			count++
		}
	}
	return seq + count
}
