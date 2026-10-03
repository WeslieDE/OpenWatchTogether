package pipeline

import (
	"bufio"
	"bytes"
	"fmt"
	"math"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"tk.weslie/watch-together-hlsstream/internal/sfuclient"
)

// TestLiveSourceAVSync schickt per RTP eine Uebertragung mit einem weissen
// Blitz und einem Piepton, die alle 2s exakt gleichzeitig kommen - so, wie
// der SFU sie an HLSStream liefert (VP8 + Opus, RTCP auf demselben Port,
// seltene Keyframes wie bei einer Bildschirmuebertragung). Der Sender laeuft
// schon, bevor die Live-Quelle startet. Im fertigen HLS muessen Blitz und
// Piepton weiterhin zusammenfallen.
func TestLiveSourceAVSync(t *testing.T) {
	if testing.Short() {
		t.Skip("braucht ~25s")
	}
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg nicht gefunden")
	}

	const vPort, aPort = 46100, 46102
	sender := exec.Command(ffmpeg, "-hide_banner", "-loglevel", "error", "-re",
		"-f", "lavfi", "-i", "color=black:s=640x360:r=30,drawbox=w=iw:h=ih:c=white:t=fill:enable='lt(mod(t,2),0.2)'",
		"-f", "lavfi", "-i", "aevalsrc='if(lt(mod(t,2),0.2),0.8*sin(2*PI*1000*t),0)|if(lt(mod(t,2),0.2),0.8*sin(2*PI*1000*t),0)':s=48000",
		"-map", "0:v", "-c:v", "libvpx", "-deadline", "realtime", "-g", "150", "-b:v", "1M",
		"-payload_type", "101", "-f", "rtp", fmt.Sprintf("rtp://127.0.0.1:%d?rtcpport=%d", vPort, vPort),
		"-map", "1:a", "-c:a", "libopus", "-ar", "48000", "-ac", "2",
		"-payload_type", "100", "-f", "rtp", fmt.Sprintf("rtp://127.0.0.1:%d?rtcpport=%d", aPort, aPort),
	)
	if err := sender.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = sender.Process.Kill(); _ = sender.Wait() }()
	// Die Uebertragung laeuft schon, der naechste Keyframe (alle 5s) kommt
	// erst 2s nach dem Start der Live-Quelle - wie beim Beitritt von
	// HLSStream in eine laufende Bildschirmuebertragung.
	time.Sleep(3 * time.Second)

	dir := t.TempDir()
	pipes, err := NewPipes()
	if err != nil {
		t.Fatal(err)
	}
	defer pipes.Close()
	enc, err := NewEncoder(ffmpeg, dir, "test", pipes.VideoR, pipes.AudioR)
	if err != nil {
		t.Fatal(err)
	}
	defer enc.Close()

	sdp, err := WriteLiveSDP(dir,
		sfuclient.Track{Kind: "video", Port: vPort, PayloadType: 101, MimeType: "video/VP8", ClockRate: 90000},
		&sfuclient.Track{Kind: "audio", Port: aPort, PayloadType: 100, MimeType: "audio/opus", ClockRate: 48000, Channels: 2})
	if err != nil {
		t.Fatal(err)
	}
	src, err := StartLiveSource(ffmpeg, "test", sdp, true, pipes, nil)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(16 * time.Second)
	src.Stop()
	if _, _, err := pipes.Align(src.Forwarders()); err != nil {
		t.Fatal(err)
	}
	time.Sleep(3 * time.Second)

	segs, _ := filepath.Glob(filepath.Join(dir, "seg-*.ts"))
	sort.Strings(segs)
	if len(segs) < 4 {
		t.Fatalf("zu wenige Segmente: %d", len(segs))
	}
	in := "concat:" + strings.Join(segs, "|")

	flashes := onsets(t, ffmpeg, in, "-map", "0:v", "-vf", "signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-", 128)
	beeps := onsets(t, ffmpeg, in, "-map", "0:a", "-af", "asetnsamples=240,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-", -20)
	t.Logf("Blitze: %v", flashes)
	t.Logf("Pieptoene: %v", beeps)
	if len(flashes) < 4 || len(beeps) < 4 {
		t.Fatalf("zu wenige Marker gefunden")
	}
	for _, f := range flashes {
		best := math.Inf(1)
		for _, b := range beeps {
			if d := b - f; math.Abs(d) < math.Abs(best) {
				best = d
			}
		}
		t.Logf("Blitz %.3fs: Ton %+.0fms", f, best*1000)
		if math.Abs(best) > 0.08 {
			t.Errorf("Blitz bei %.3fs: Ton um %+.0fms versetzt", f, best*1000)
		}
	}
}

var (
	ptsRe = regexp.MustCompile(`pts_time:([0-9.]+)`)
	valRe = regexp.MustCompile(`=(-?[0-9.]+|-inf)$`)
)

// onsets liefert die Zeitpunkte, an denen der Messwert die Schwelle von
// unten ueberschreitet.
func onsets(t *testing.T, ffmpeg, in string, args ...any) []float64 {
	t.Helper()
	threshold := args[len(args)-1].(int)
	cmdArgs := []string{"-hide_banner", "-loglevel", "error", "-i", in}
	for _, a := range args[:len(args)-1] {
		cmdArgs = append(cmdArgs, a.(string))
	}
	cmdArgs = append(cmdArgs, "-f", "null", "-")
	out, err := exec.Command(ffmpeg, cmdArgs...).Output()
	if err != nil {
		t.Fatalf("analyse: %v", err)
	}
	var res []float64
	var pts float64
	above := true // erst nach einem Wert unter der Schwelle zaehlen
	sc := bufio.NewScanner(bytes.NewReader(out))
	for sc.Scan() {
		line := sc.Text()
		if m := ptsRe.FindStringSubmatch(line); m != nil {
			pts, _ = strconv.ParseFloat(m[1], 64)
			continue
		}
		m := valRe.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		v := math.Inf(-1)
		if m[1] != "-inf" {
			v, _ = strconv.ParseFloat(m[1], 64)
		}
		if v >= float64(threshold) && !above {
			res = append(res, pts)
		}
		above = v >= float64(threshold)
	}
	return res
}
