package pipeline

import (
	"bufio"
	"bytes"
	"strconv"
	"strings"
)

// HoldSequence ist die Medien-Sequenznummer, die das Standbild-Segment aus
// RenderHold() in der Ersatz-Playlist (httpapi.writeHoldPlaylist) belegt.
// Die echten Segmente von ffmpeg werden in RewritePlaylist() um
// sequenceOffset dahinter verschoben, damit eine Nummer nie fuer zwei
// verschiedene Segmente steht.
const HoldSequence = 0

const sequenceOffset = HoldSequence + 1

// RewritePlaylist macht aus der von ffmpeg geschriebenen index.m3u8 eine
// Playlist, die ueber den Wechsel vom Standbild-Segment auf den echten Stream
// und ueber das gesamte Gleitfenster hinweg in sich stimmig bleibt.
//
// Ohne das widersprach sie sich an zwei Stellen, beide gemessen gegen
// https://vrtogether.de/stream/weslie.m3u8 (2026-10-02):
//
//   - Die Ersatz-Playlist nennt Segment 0 "_hold.ts", ffmpegs erste Playlist
//     danach Segment 0 "seg-00000.ts" mit vorangestelltem
//     EXT-X-DISCONTINUITY. Dieselbe Nummer steht so fuer zwei verschiedene
//     Segmente in zwei verschiedenen Discontinuity-Sequenzen.
//   - ffmpeg schreibt nie EXT-X-DISCONTINUITY-SEQUENCE. Faellt das Segment
//     mit dem DISCONTINUITY-Tag aus dem Fenster, springt die Discontinuity-
//     Sequenz aller verbleibenden Segmente von 1 zurueck auf 0.
//
// Strenge Player (ExoPlayer, also u.a. AVPro auf Quest/Android in VRChat)
// werten beides als zurueckgesetzte Playlist und brechen ab - typischerweise
// genau bei den Zuschauern, die in den ersten Sekunden nach dem Raumbeitritt
// noch das Standbild-Segment bekommen haben.
//
// Daher hier: alle Sequenznummern um sequenceOffset hinter das
// Standbild-Segment verschieben, ffmpegs eigene DISCONTINUITY-Tags verwerfen
// und stattdessen vor jedes Segment, mit dem ein Encoder-Lauf begonnen hat
// (runStarts, siehe Encoder.supervise()), selbst eines setzen - inklusive
// des Zaehlers EXT-X-DISCONTINUITY-SEQUENCE fuer alle, die schon aus dem
// Fenster gefallen sind. Der Beginn des allerersten Laufs zaehlt dabei immer
// als Bruch, weil davor (aus Sicht des Players) das Standbild-Segment mit
// eigenen Zeitstempeln lag.
func RewritePlaylist(src []byte, runStarts []int) []byte {
	isStart := make(map[int]bool, len(runStarts))
	for _, n := range runStarts {
		isStart[n] = true
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
	for n := range isStart {
		if n < mediaSeq {
			discSeq++
		}
	}

	var out bytes.Buffer
	next := mediaSeq // ffmpeg-Nummer des naechsten Segments in der Liste
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
			out.WriteString("#EXT-X-MEDIA-SEQUENCE:" + strconv.Itoa(mediaSeq+sequenceOffset) + "\n")
			out.WriteString("#EXT-X-DISCONTINUITY-SEQUENCE:" + strconv.Itoa(discSeq) + "\n")
			continue
		case strings.HasPrefix(line, "#EXTINF:"):
			if isStart[next] {
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
