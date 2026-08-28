/* ============================================================================
   tk.weslie.WatchTogether.transcode

   mkv/avi kann kein Browser einbetten. Bevor so eine Datei hochgeht, macht
   dieses Modul aus ihr ein mp4 - ganz auf dem Geraet der hochladenden
   Person, der Server sieht davon nichts.

   Steckt im Container schon H.264/AAC drin, wird nur umgepackt (schnell,
   praktisch verlustfrei). Sonst greift ffmpeg.wasm durch - reine
   Software-Umwandlung, denn im WASM-Sandkasten gibt es keinen Zugriff auf
   die GPU.

   mp3 laeuft denselben Weg, nur ohne eigene Videospur: dafuer wird
   COVER_IMAGE als Standbild vor den Ton gelegt, damit am Ende wieder ein
   normales mp4 herauskommt, das der Rest der App wie jedes andere Video
   behandeln kann.

   ffmpeg.wasm wiegt gut 30 MB und wird darum erst geholt, wenn wirklich
   etwas umzuwandeln ist - nie beim blossen Seitenaufruf.
   ========================================================================= */
(function (global) {
  "use strict";

  var WT = global.tk.weslie.WatchTogether;
  var doc = global.document;

  var VENDOR = "assets/vendor/ffmpeg/";
  var COVER_IMAGE = "assets/img/VideoImage.png";
  var CONVERTIBLE = /^(mkv|avi)$/;
  var AUDIO_ONLY = /^(mp3)$/;

  /* ---------------------------------------------------------------- Geraet */

  function isMobile() {
    var uaData = global.navigator.userAgentData;
    if (uaData && typeof uaData.mobile === "boolean") return uaData.mobile;
    return /Android|iPhone|iPad|iPod|IEMobile|Windows Phone|Mobile/i.test(global.navigator.userAgent || "");
  }

  function extOf(name) {
    return (name.split(".").pop() || "").toLowerCase();
  }

  function isAudioOnly(file) {
    return AUDIO_ONLY.test(extOf(file.name));
  }

  function needsConversion(file) {
    return CONVERTIBLE.test(extOf(file.name)) || isAudioOnly(file);
  }

  /* ---------------------------------------------------------- ffmpeg laden */

  var scriptPromise = null;
  function loadScript() {
    if (!scriptPromise) {
      scriptPromise = new Promise(function (resolve, reject) {
        if (global.FFmpegWASM) { resolve(); return; }
        var s = doc.createElement("script");
        s.src = VENDOR + "ffmpeg.js";
        s.onload = function () { resolve(); };
        s.onerror = function () { reject(new Error("ffmpeg.wasm liess sich nicht laden.")); };
        doc.head.appendChild(s);
      });
    }
    return scriptPromise;
  }

  /* Absolut, denn der Worker loest relative Pfade gegen sein eigenes Skript
     auf, nicht gegen die Seite - sonst sucht er ffmpeg-core.js am falschen
     Ort. */
  function abs(path) {
    return new global.URL(path, doc.baseURI).href;
  }

  var ffmpegPromise = null;
  function loadFFmpeg() {
    if (!ffmpegPromise) {
      ffmpegPromise = loadScript().then(function () {
        var ff = new global.FFmpegWASM.FFmpeg();
        return ff.load({
          coreURL: abs(VENDOR + "ffmpeg-core.js"),
          wasmURL: abs(VENDOR + "ffmpeg-core.wasm")
        }).then(function () { return ff; });
      });
    }
    return ffmpegPromise;
  }

  /* Nach einem Abbruch faengt der naechste Job frisch an. */
  function dropFFmpeg(ff) {
    ffmpegPromise = null;
    try { ff.terminate(); } catch (e) { /* schon weg */ }
  }

  /* Einmal geladen, reicht fuer die ganze Sitzung - das Bild aendert sich
     zur Laufzeit nicht. */
  var coverPromise = null;
  function loadCover() {
    if (!coverPromise) {
      coverPromise = global.fetch(abs(COVER_IMAGE))
        .then(function (res) {
          if (!res.ok) throw new Error("Titelbild liess sich nicht laden.");
          return res.arrayBuffer();
        })
        .then(function (buf) { return new Uint8Array(buf); });
    }
    return coverPromise;
  }

  /* ------------------------------------------------------------- Sondieren */
  /* "ffmpeg -i" ohne Ausgabedatei bricht immer mit Fehler ab - genau darauf
     kommt es an, denn dabei schreibt ffmpeg die Spurinfo ins Log. */

  function probe(ff, name) {
    var lines = [];
    function collect(e) { lines.push(e.message || ""); }
    ff.on("log", collect);

    return ff.exec(["-i", name]).catch(function () { /* erwartet */ }).then(function () {
      ff.off("log", collect);
      var text = lines.join("\n");
      var video = /Video:\s*([a-zA-Z0-9_]+)/.exec(text);
      var audio = /Audio:\s*([a-zA-Z0-9_]+)/.exec(text);
      return {
        video: video ? video[1].toLowerCase() : null,
        audio: audio ? audio[1].toLowerCase() : null
      };
    });
  }

  /* Liegt schon H.264/AAC vor, reicht ein Wechsel des Containers. */
  function isRemuxable(info) {
    return info.video === "h264" && (!info.audio || info.audio === "aac");
  }

  /* ---------------------------------------------------------------- Ablauf */

  function toU8(file) {
    return file.arrayBuffer().then(function (buf) { return new Uint8Array(buf); });
  }

  function swapExt(name, ext) {
    return name.replace(/\.[^.]+$/, "") + "." + ext;
  }

  function clampFrac(v) {
    if (!isFinite(v) || v < 0) return 0;
    return v > 1 ? 1 : v;
  }

  /* Bei mp3 gibt es keine Videospur zu probieren - stattdessen legt sich
     COVER_IMAGE als Standbild vor den Ton. Die Videospur traegt dabei keine
     Information (das Bild aendert sich nie), darum so klein und billig wie
     moeglich: 320p/15fps/500kbit halten die reine Software-Kodierung im
     WASM-Sandkasten schnell, waehrend der Ton unangetastet bleibt. "scale"
     rundet zugleich auf eine gerade Breite/Hoehe, denn yuv420p braucht durch
     das Chroma-Subsampling beides gerade, sonst wuerde libx264 den Encoder
     gar nicht erst oeffnen. "-g 15" erzwingt ein Keyframe pro Sekunde, obwohl
     sich das Bild nie aendert: ohne das waere ein Sprung mitten in eine
     Stunde Ton nicht moeglich, weil der Decoder erst das naechste,
     womoeglich weit entfernte Keyframe braeuchte - die Frames dazwischen
     bleiben trotzdem fast umsonst, weil sie exakt gleich sind. */
  function audioImageArgs(inName, imgName, outName) {
    return [
      "-loop", "1", "-framerate", "15", "-i", imgName,
      "-i", inName,
      "-map", "0:v", "-map", "1:a",
      "-c:v", "libx264", "-tune", "stillimage", "-pix_fmt", "yuv420p",
      "-vf", "scale=320:-2,fps=15", "-g", "15", "-keyint_min", "15",
      "-b:v", "500k", "-maxrate", "500k", "-bufsize", "500k",
      "-c:a", "aac", "-b:a", "192k",
      "-shortest", "-movflags", "+faststart", outName
    ];
  }

  /**
   * opts: onProgress(fraction 0..1)
   * Rueckgabe: { promise: Promise<File>, cancel() }
   */
  function convert(file, onProgress) {
    var cancelled = false;
    var ff = null;
    var audioOnly = isAudioOnly(file);

    function guard() {
      if (cancelled) { var e = new Error("Abgebrochen"); e.reason = "aborted"; throw e; }
    }

    var promise = Promise.all([loadFFmpeg(), audioOnly ? loadCover() : null]).then(function (res) {
      guard();
      ff = res[0];
      var cover = res[1];

      var inName  = "in-" + Math.random().toString(36).slice(2, 8) + "." + extOf(file.name);
      var outName = "out-" + Math.random().toString(36).slice(2, 8) + ".mp4";
      var imgName = "cover-" + Math.random().toString(36).slice(2, 8) + ".png";
      var onTick = function (e) { if (onProgress) onProgress(clampFrac(e.progress)); };

      var written = toU8(file).then(function (data) { guard(); return ff.writeFile(inName, data); });
      /* writeFile() transferiert den Buffer an den Worker und entleert ihn
         damit im Hauptthread - "cover" wird aber pro Sitzung nur einmal
         geladen und muss fuer die naechste Datei unversehrt bleiben, darum
         hier eine frische Kopie statt des gecachten Arrays selbst. */
      if (audioOnly) {
        written = written.then(function () { guard(); return ff.writeFile(imgName, cover.slice()); });
      }

      return written
        .then(function () { guard(); return audioOnly ? null : probe(ff, inName); })
        .then(function (info) {
          guard();
          var args = audioOnly
            ? audioImageArgs(inName, imgName, outName)
            : isRemuxable(info)
            ? ["-i", inName, "-c", "copy", "-movflags", "+faststart", outName]
            : ["-i", inName,
               "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
               "-c:a", "aac", "-b:a", "160k",
               "-movflags", "+faststart", outName];
          ff.on("progress", onTick);
          return ff.exec(args);
        })
        .then(function () {
          ff.off("progress", onTick);
          guard();
          return ff.readFile(outName);
        }, function (err) {
          ff.off("progress", onTick);
          throw err;
        })
        .then(function (data) {
          ff.deleteFile(inName).catch(function () {});
          ff.deleteFile(outName).catch(function () {});
          if (audioOnly) ff.deleteFile(imgName).catch(function () {});
          if (!data || !data.length) throw new Error("Die Datei liess sich nicht umwandeln.");
          var blob = new Blob([data.buffer], { type: "video/mp4" });
          return new File([blob], swapExt(file.name, "mp4"), { type: "video/mp4" });
        });
    });

    return {
      promise: promise.catch(function (err) {
        if (err && err.reason === "aborted") throw err;
        throw new Error(err && err.message ? err.message : "Die Datei liess sich nicht umwandeln.");
      }),
      cancel: function () {
        if (cancelled) return;
        cancelled = true;
        if (ff) dropFFmpeg(ff);
      }
    };
  }

  WT.transcode = {
    isMobile: isMobile,
    needsConversion: needsConversion,
    convert: convert
  };

})(window);
