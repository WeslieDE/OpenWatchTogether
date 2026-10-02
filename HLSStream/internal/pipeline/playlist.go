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
// dieser Playlist, ohne Widerspruch und ohne Bruch.
//
//   - Das Standbild bleibt als Segment 0 vorn stehen, solange ffmpegs Fenster
//     noch bei dessen erstem Segment beginnt, und faellt danach regulaer
//     heraus. ffmpegs Segment n wird zu Sequenznummer n+1. Frueher meldete
//     ffmpeg Segment 0 selbst als "seg-00000.ts" - dieselbe Nummer fuer zwei
//     verschiedene Segmente, gemessen gegen vrtogether.de am 2026-10-02.
//     Ein erster Versuch (2c2e0a9) verschob die Nummern, liess das Standbild
//     aber sofort fallen: VLC wartet beim Live-Start, bis genug Puffer da
//     ist, und blieb fuer immer haengen, wenn das Segment, auf dem es stand,
//     verschwand.
//   - Die Zeitstempel des Encoders beginnen per -output_ts_offset genau
//     hinter dem Standbild (siehe encoder.args()), der Uebergang braucht
//     also kein EXT-X-DISCONTINUITY. Genau so ein Bruch liess Wines
//     MediaFoundation-Nachbau (AVPro in VRChat unter Proton) mit einer
//     Assertion in mf/session.c abstuerzen.
//   - ffmpegs eigene DISCONTINUITY-Tags (append_list setzt eines an jeden
//     Laufbeginn, auch den ersten) werden verworfen. Ein echter Bruch steht
//     nur vor Segmenten, mit denen ein Encoder-Neustart begonnen hat
//     (runStarts, siehe Encoder.supervise()) - ausser Segment 0, das ja
//     nahtlos an das Standbild anschliesst. Fuer Brueche, die schon aus dem
//     Fenster gefallen sind, zaehlt EXT-X-DISCONTINUITY-SEQUENCE weiter;
//     ffmpeg selbst schreibt das nie, die Discontinuity-Sequenz liefe sonst
//     zurueck.
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
	withHold := mediaSeq == 0

	discSeq := 0
	for n := range isBreak {
		if n < mediaSeq {
			discSeq++
		}
	}

	var out bytes.Buffer
	next := mediaSeq // ffmpeg-Nummer des naechsten Segments in der Liste
	headerDone := false
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
			seq := mediaSeq + 1
			if withHold {
				seq = 0
			}
			out.WriteString("#EXT-X-MEDIA-SEQUENCE:" + strconv.Itoa(seq) + "\n")
			if discSeq > 0 {
				out.WriteString("#EXT-X-DISCONTINUITY-SEQUENCE:" + strconv.Itoa(discSeq) + "\n")
			}
			continue
		case strings.HasPrefix(line, "#EXTINF:"):
			if !headerDone {
				headerDone = true
				if withHold {
					out.WriteString(HoldEntry())
				}
			}
			if isBreak[next] {
				out.WriteString("#EXT-X-DISCONTINUITY\n")
			}
		case !strings.HasPrefix(line, "#"):
			next++
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
