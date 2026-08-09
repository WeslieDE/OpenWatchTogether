/* ============================================================================
   tk.weslie.WatchTogether.transcode

   mkv/avi kann kein Browser einbetten. Bevor so eine Datei hochgeht, macht
   dieses Modul aus ihr ein mp4 - ganz auf dem Geraet der hochladenden
   Person, der Server sieht davon nichts.

   Steckt im Container schon H.264/AAC drin, wird nur umgepackt (schnell,
   praktisch verlustfrei). Sonst greift ffmpeg.wasm durch - reine
   Software-Umwandlung, denn im WASM-Sandkasten gibt es keinen Zugriff auf
   die GPU.

   ffmpeg.wasm wiegt gut 30 MB und wird darum erst geholt, wenn wirklich
   etwas umzuwandeln ist - nie beim blossen Seitenaufruf.
   ========================================================================= */
(function (global) {
  "use strict";

  var WT = global.tk.weslie.WatchTogether;
  var doc = global.document;

  var VENDOR = "assets/vendor/ffmpeg/";
  var CONVERTIBLE = /^(mkv|avi)$/;

  /* ---------------------------------------------------------------- Geraet */

  function isMobile() {
    var uaData = global.navigator.userAgentData;
    if (uaData && typeof uaData.mobile === "boolean") return uaData.mobile;
    return /Android|iPhone|iPad|iPod|IEMobile|Windows Phone|Mobile/i.test(global.navigator.userAgent || "");
  }

  function extOf(name) {
    return (name.split(".").pop() || "").toLowerCase();
  }

  function needsConversion(file) {
    return CONVERTIBLE.test(extOf(file.name));
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

  /**
   * opts: onProgress(fraction 0..1)
   * Rueckgabe: { promise: Promise<File>, cancel() }
   */
  function convert(file, onProgress) {
    var cancelled = false;
    var ff = null;

    function guard() {
      if (cancelled) { var e = new Error("Abgebrochen"); e.reason = "aborted"; throw e; }
    }

    var promise = loadFFmpeg().then(function (instance) {
      guard();
      ff = instance;

      var inName  = "in-" + Math.random().toString(36).slice(2, 8) + "." + extOf(file.name);
      var outName = "out-" + Math.random().toString(36).slice(2, 8) + ".mp4";
      var onTick = function (e) { if (onProgress) onProgress(clampFrac(e.progress)); };

      return toU8(file)
        .then(function (data) { guard(); return ff.writeFile(inName, data); })
        .then(function () { guard(); return probe(ff, inName); })
        .then(function (info) {
          guard();
          var args = isRemuxable(info)
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
