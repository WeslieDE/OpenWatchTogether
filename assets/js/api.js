/* ============================================================================
   tk.weslie.WatchTogether.api

   Alles, was ueber gewoehnliches HTTP laeuft: Raum betreten, Warteschlange
   holen, Video loeschen und der Upload.

   Der Upload geht in Stuecken hoch. Das kommt ohne grosse Werte in der
   php.ini aus, macht den Fortschritt genau und laesst sich jederzeit
   abbrechen. Ist alles da, kuemmert sich der Server um Laufzeit und
   Vorschaubild.
   ========================================================================= */
(function (global) {
  "use strict";

  var WT = global.tk.weslie.WatchTogether;

  var BASE = "api/index.php";
  var settings = { chunkBytes: 4 * 1048576, needsPoster: false };

  function url(action, params) {
    var q = "?do=" + encodeURIComponent(action);
    if (params) {
      Object.keys(params).forEach(function (k) {
        if (params[k] != null) q += "&" + k + "=" + encodeURIComponent(params[k]);
      });
    }
    return BASE + q;
  }

  function unwrap(res) {
    return res.json().then(function (data) {
      if (!res.ok || !data || data.ok === false) {
        var err = new Error((data && data.error) || "Der Server antwortet nicht wie erwartet.");
        err.reason = (data && data.reason) || "server";
        throw err;
      }
      return data;
    }, function () {
      var err = new Error("Der Server antwortet nicht wie erwartet.");
      err.reason = "server";
      throw err;
    });
  }

  function get(action, params) {
    return global.fetch(url(action, params), { credentials: "same-origin" }).then(unwrap);
  }

  function post(action, body) {
    return global.fetch(url(action), {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    }).then(unwrap);
  }

  /* ---------------------------------------------------------------- Upload */
  /* XHR statt fetch, weil nur XHR den Fortschritt des Sendens meldet. */

  /**
   * opts: room, file, title, by, byId, onProgress(sent, total), onStart(id)
   * Rueckgabe: { promise, cancel() }
   */
  function upload(opts) {
    var cancelled = false;
    var xhr = null;
    var uploadId = null;

    function guard() {
      if (cancelled) {
        var err = new Error("Abgebrochen");
        err.reason = "aborted";
        throw err;
      }
    }

    var promise = post("upload-begin", {
      room: opts.room,
      name: opts.file.name,
      size: opts.file.size
    }).then(function (started) {
      guard();
      uploadId = started.id;
      if (opts.onStart) opts.onStart(uploadId);

      var size = opts.file.size;
      var step = started.chunk || settings.chunkBytes;

      /* Ein Stueck nach dem anderen, jeweils ab dem Versatz, den der Server
         bestaetigt hat. */
      function next(offset) {
        guard();
        if (offset >= size) return offset;

        var slice = opts.file.slice(offset, Math.min(offset + step, size));
        var target = url("upload-chunk", { room: opts.room, id: uploadId, offset: offset });

        return new Promise(function (resolve, reject) {
          var req = new global.XMLHttpRequest();
          xhr = req;
          req.open("POST", target, true);
          req.setRequestHeader("Content-Type", "application/octet-stream");

          req.upload.onprogress = function (e) {
            if (opts.onProgress && e.lengthComputable) {
              opts.onProgress(offset + e.loaded, size);
            }
          };
          req.onload = function () {
            xhr = null;
            var data = null;
            try { data = JSON.parse(req.responseText); } catch (e) { /* gleich unten */ }
            if (req.status >= 200 && req.status < 300 && data && data.ok) {
              if (opts.onProgress) opts.onProgress(data.received, size);
              resolve(data.received);
            } else {
              var err = new Error((data && data.error) || "Die Uebertragung ist abgerissen.");
              err.reason = (data && data.reason) || "network";
              reject(err);
            }
          };
          req.onerror = function () {
            xhr = null;
            var err = new Error("Die Uebertragung ist abgerissen.");
            err.reason = "network";
            reject(err);
          };
          req.onabort = function () {
            xhr = null;
            var err = new Error("Abgebrochen");
            err.reason = "aborted";
            reject(err);
          };
          req.send(slice);
        }).then(next);
      }

      return next(0);
    }).then(function () {
      guard();
      /* Laufzeit und Bild macht der Server. Nur wenn dort kein ffmpeg liegt,
         steuert der Browser bei, was er selbst aus der Datei lesen kann. */
      if (!settings.needsPoster) return { duration: 0, poster: null };
      return WT.media.fromFile(opts.file, 0.2).catch(function () {
        return { duration: 0, poster: null };
      });
    }).then(function (extra) {
      guard();
      return post("upload-finish", {
        room: opts.room,
        id: uploadId,
        title: opts.title,
        by: opts.by,
        byId: opts.byId,
        duration: extra.duration || 0,
        poster: extra.poster || null
      });
    }).then(function (res) {
      return res.item;
    });

    return {
      promise: promise,
      cancel: function () {
        if (cancelled) return;
        cancelled = true;
        if (xhr) { try { xhr.abort(); } catch (e) { /* schon vorbei */ } }
        if (uploadId) {
          post("upload-abort", { room: opts.room, id: uploadId }).catch(function () {});
        }
      }
    };
  }

  WT.api = {
    /* Einmal beim Start: Adresse der Live-Verbindung, Obergrenzen, ffmpeg. */
    boot: function () {
      return get("config").then(function (cfg) {
        settings = cfg;
        return cfg;
      });
    },
    settings: function () { return settings; },
    room:   function (slug) { return post("room", { room: slug }); },
    queue:  function (slug) { return get("queue", { room: slug }); },
    remove: function (slug, id) { return post("remove", { room: slug, id: id }); },
    upload: upload,
    url: url
  };

})(window);
