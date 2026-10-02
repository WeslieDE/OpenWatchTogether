package pipeline

import (
	"strings"
	"testing"
)

// Erste Playlist nach dem Standbild: Segment 0 von ffmpeg muss hinter das
// Standbild (HoldSequence) ruecken und mit einem Bruch anschliessen.
func TestRewritePlaylistAfterHold(t *testing.T) {
	src := "#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n" +
		"#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-DISCONTINUITY\n#EXTINF:2.000000,\n/s/seg-00000.ts\n" +
		"#EXTINF:2.000000,\n/s/seg-00001.ts\n"
	want := "#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:1\n" +
		"#EXT-X-DISCONTINUITY-SEQUENCE:0\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-DISCONTINUITY\n" +
		"#EXTINF:2.000000,\n/s/seg-00000.ts\n#EXTINF:2.000000,\n/s/seg-00001.ts\n"
	if got := string(RewritePlaylist([]byte(src), []int{0})); got != want {
		t.Fatalf("got:\n%s\nwant:\n%s", got, want)
	}
}

// Ist der Lauf-Beginn aus dem Fenster gefallen, darf die Discontinuity-
// Sequenz nicht zuruecklaufen; ein spaeterer Neustart (Segment 12) bekommt
// seinen eigenen Bruch, auch wenn ffmpeg dort keinen markiert haette.
func TestRewritePlaylistSlidingWindow(t *testing.T) {
	src := "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:10\n#EXTINF:2,\nseg-00010.ts\n#EXTINF:2,\nseg-00011.ts\n" +
		"#EXTINF:2,\nseg-00012.ts\n"
	got := string(RewritePlaylist([]byte(src), []int{0, 12}))
	for _, want := range []string{
		"#EXT-X-MEDIA-SEQUENCE:11\n",
		"#EXT-X-DISCONTINUITY-SEQUENCE:1\n",
		"seg-00011.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:2,\nseg-00012.ts\n",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("%q fehlt in:\n%s", want, got)
		}
	}
	if strings.Count(got, "#EXT-X-DISCONTINUITY\n") != 1 {
		t.Fatalf("genau ein DISCONTINUITY erwartet:\n%s", got)
	}
}

func TestNextSegmentNumber(t *testing.T) {
	if n := nextSegmentNumber(nil); n != 0 {
		t.Fatalf("leer: %d", n)
	}
	src := "#EXT-X-MEDIA-SEQUENCE:7\n#EXTINF:2,\na.ts\n#EXTINF:2,\nb.ts\n"
	if n := nextSegmentNumber([]byte(src)); n != 9 {
		t.Fatalf("got %d, want 9", n)
	}
}
