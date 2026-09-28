package pipeline

import (
	"os"
	"os/exec"
	"strconv"
	"testing"
	"time"
)

// TestAlignWithStuckForwarder stellt den Haenger aus dem Raum "lilhannah"
// nach: das Bild laeuft dem Ton weit voraus (wie eine Live-Quelle im Burst),
// der Encoder liest es deshalb nicht weiter, und die Bild-Weiterleitung
// haengt beim Kill mitten in einem write(). Align() muss trotzdem
// zurueckkehren und beide Spuren gleich lang hinterlassen.
func TestAlignWithStuckForwarder(t *testing.T) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg nicht gefunden")
	}

	pipes, err := NewPipes()
	if err != nil {
		t.Fatal(err)
	}
	defer pipes.Close()
	enc, err := NewEncoder(ffmpeg, t.TempDir(), "test", pipes.VideoR, pipes.AudioR)
	if err != nil {
		t.Fatal(err)
	}
	defer enc.Close()

	for round := 0; round < 3; round++ {
		vw, vDone, err := pipes.newVideoPipe()
		if err != nil {
			t.Fatal(err)
		}
		// Kein -re: das Bild liefert so schnell, wie der Encoder abnimmt.
		video, err := start("v", ffmpeg, []string{
			"-hide_banner", "-loglevel", "error",
			"-f", "lavfi", "-i", "testsrc=size=1280x720:rate=" + strconv.Itoa(FPS),
			"-pix_fmt", "yuv420p", "-f", "rawvideo", "pipe:3",
		}, []*os.File{vw}, "[test bild]")
		vw.Close()
		if err != nil {
			t.Fatal(err)
		}
		aw, aDone, err := pipes.newAudioPipe()
		if err != nil {
			t.Fatal(err)
		}
		audioArgs := append([]string{"-hide_banner", "-loglevel", "error", "-re", "-f", "lavfi", "-i", silentSource()}, audioOutputArgs()...)
		audio, err := start("a", ffmpeg, audioArgs, []*os.File{aw}, "[test ton]")
		aw.Close()
		if err != nil {
			t.Fatal(err)
		}
		src := &SourcePair{Video: video, Audio: audio, forwarders: []<-chan struct{}{vDone, aDone}}

		time.Sleep(1500 * time.Millisecond)
		src.Stop()

		done := make(chan error, 1)
		var frames, samples int64
		go func() {
			var err error
			frames, samples, err = pipes.Align(src.Forwarders())
			done <- err
		}()
		select {
		case err := <-done:
			if err != nil {
				t.Fatalf("Runde %d: Align: %v", round, err)
			}
		case <-time.After(10 * time.Second):
			t.Fatalf("Runde %d: Align haengt", round)
		}
		v, a := pipes.videoFrames.Load(), pipes.audioSamples.Load()
		t.Logf("Runde %d: +%d Bilder, +%d Samples -> %d Bilder / %d Samples", round, frames, samples, v, a)
		if v*samplesPerFrame != a {
			t.Fatalf("Runde %d: nicht gleich lang: %d Bilder, %d Samples", round, v, a)
		}
	}
}
