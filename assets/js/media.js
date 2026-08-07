/* ============================================================================
   tk.weslie.WatchTogether.media

   Der Player. Eine schmale Schicht um das <video>-Element, damit die
   Oberflaeche nur mit Position, Laufzeit und Tempo zu tun hat.

   Dazu ein Notnagel: kann der Server kein Vorschaubild erzeugen, weil dort
   kein ffmpeg liegt, entstehen Laufzeit und Bild hier im Browser aus der
   gewaehlten Datei.
   ========================================================================= */
(function (global) {
  "use strict";

  var WT = global.tk.weslie.WatchTogether;

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function timecode(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    var whole = Math.floor(sec);
    var h = Math.floor(whole / 3600);
    var m = Math.floor((whole % 3600) / 60);
    var s = whole % 60;
    var mm = h > 0 && m < 10 ? "0" + m : String(m);
    return (h > 0 ? h + ":" : "") + mm + ":" + (s < 10 ? "0" + s : s);
  }

  /* -------------------------------------------------------------- Player -- */

  function Surface(video) {
    this.video = video;
    this.item = null;
    this.onEnded = null;
    this.onTick = null;
    this.onBlocked = null;      /* der Browser hat das Abspielen abgelehnt */
    this._volume = 0.5;
    this._muted = false;
    this._raf = 0;

    var self = this;
    video.addEventListener("ended", function () {
      if (self.item && self.onEnded) self.onEnded();
    });

    this._loop = function () {
      self._raf = global.requestAnimationFrame(self._loop);
      if (self.onTick) self.onTick();
    };
  }

  Surface.prototype.start = function () {
    if (!this._raf) this._raf = global.requestAnimationFrame(this._loop);
  };

  Surface.prototype.stop = function () {
    if (this._raf) { global.cancelAnimationFrame(this._raf); this._raf = 0; }
  };

  Surface.prototype.load = function (item) {
    this.unload();
    if (!item || !item.url) return;

    this.item = item;
    this.video.hidden = false;
    this.video.src = item.url;
    this.video.volume = this._volume;
    this.video.muted = this._muted;
    this.video.playbackRate = 1;
    this.video.load();
  };

  Surface.prototype.unload = function () {
    if (this.item) {
      this.video.pause();
      this.video.removeAttribute("src");
      this.video.load();
    }
    this.item = null;
    this.video.hidden = true;
  };

  Surface.prototype.play = function () {
    if (!this.item) return;
    var self = this;
    var p = this.video.play();
    /* Ohne vorherige Bedienung darf der Browser ablehnen. Dann bleibt der
       grosse Knopf stehen, bis jemand ihn drueckt. */
    if (p && p.catch) {
      p.catch(function () {
        if (self.onBlocked) self.onBlocked();
      });
    }
  };

  Surface.prototype.pause = function () {
    if (this.item) this.video.pause();
  };

  Surface.prototype.seek = function (t) {
    if (!this.item) return;
    var len = this.length;
    try {
      this.video.currentTime = len ? clamp(t, 0, len) : Math.max(0, t);
    } catch (e) { /* zu frueh, der naechste Abgleich holt es nach */ }
  };

  Object.defineProperties(Surface.prototype, {
    ready:    { get: function () { return this.item !== null; } },
    /* Erst wenn Bild und Laufzeit stehen, laesst sich sauber angleichen. */
    settled:  { get: function () {
      return this.item !== null && this.video.readyState >= 1 && isFinite(this.video.duration);
    }},
    /* Genug im Puffer, um sofort loszuspielen und nicht gleich wieder zu
       stocken. Darauf wartet der Raum beim Wechsel auf ein anderes Video. */
    playable: { get: function () {
      return this.item !== null && this.video.readyState >= 3;
    }},
    paused:   { get: function () { return this.item === null || this.video.paused; } },
    position: { get: function () { return this.item ? (this.video.currentTime || 0) : 0; } },
    length:   { get: function () {
      if (!this.item) return 0;
      if (isFinite(this.video.duration) && this.video.duration > 0) return this.video.duration;
      return this.item.duration || 0;
    }},
    rate: {
      get: function () { return this.item ? this.video.playbackRate : 1; },
      set: function (v) { if (this.item) this.video.playbackRate = v; }
    },
    volume: {
      get: function () { return this._volume; },
      set: function (v) { this._volume = clamp(v, 0, 1); this.video.volume = this._volume; }
    },
    muted: {
      get: function () { return this._muted; },
      set: function (v) { this._muted = !!v; this.video.muted = this._muted; }
    }
  });

  /* -------------------------------------------------- Vorschau als Ersatz -- */
  /* Nur noetig, wenn auf dem Server kein ffmpeg liegt. Gleiche Vorgaben wie
     dort: JPEG, hoechstens 420p, Standbild bei 20 Prozent der Laufzeit. */

  var POSTER_W = 640, POSTER_H = 360;

  function fromFile(file, at) {
    return new Promise(function (resolve, reject) {
      var url = global.URL.createObjectURL(file);
      var v = global.document.createElement("video");
      v.preload = "metadata";
      v.muted = true;
      v.playsInline = true;

      var done = false;
      var timer = global.setTimeout(fail, 10000);

      function cleanup() {
        global.clearTimeout(timer);
        v.removeAttribute("src");
        v.load();
        global.URL.revokeObjectURL(url);
      }
      function fail() {
        if (done) return;
        done = true;
        cleanup();
        reject(new Error("Vorschau nicht moeglich"));
      }
      function grab() {
        if (done) return;
        var duration = v.duration;
        try {
          var c = global.document.createElement("canvas");
          c.width = POSTER_W; c.height = POSTER_H;
          var ctx = c.getContext("2d");
          var vw = v.videoWidth || 16, vh = v.videoHeight || 9;
          var s = Math.max(POSTER_W / vw, POSTER_H / vh);
          var dw = vw * s, dh = vh * s;
          ctx.drawImage(v, (POSTER_W - dw) / 2, (POSTER_H - dh) / 2, dw, dh);
          var data = c.toDataURL("image/jpeg", 0.72);
          done = true;
          cleanup();
          resolve({ poster: data, duration: duration });
        } catch (e) {
          /* Ein geschuetzter Datenstrom laesst sich nicht abmalen. Dann
             wenigstens die Laufzeit mitnehmen. */
          done = true;
          cleanup();
          resolve({ poster: null, duration: duration });
        }
      }

      v.addEventListener("loadedmetadata", function () {
        if (!isFinite(v.duration) || v.duration <= 0) return fail();
        try { v.currentTime = (at == null ? 0.2 : at) * v.duration; }
        catch (e) { fail(); }
      });
      v.addEventListener("seeked", grab);
      v.addEventListener("error", fail);
      v.src = url;
    });
  }

  WT.media = {
    Surface: Surface,
    fromFile: fromFile,
    timecode: timecode,
    clamp: clamp
  };

})(window);
