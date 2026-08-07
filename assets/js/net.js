/* ============================================================================
   tk.weslie.WatchTogether.net

   Die Live-Verbindung zum langlaufenden PHP-Prozess. Uebertragen wird nur,
   was noetig ist:

     Server an Client
       welcome     kompletter Raumzustand beim Verbinden
       joined      jemand ist dazugekommen
       left        jemand ist gegangen
       named       jemand hat seinen Namen geaendert
       master      wer den Takt vorgibt
       video       Spielt oder pausiert samt Zeit, vom Taktgeber
       pos         Position der anderen Teilnehmer
       upload      laufender Upload mit Fortschritt
       upload-end  Upload fertig oder abgebrochen
       queue       Warteschlange, sobald sich etwas geaendert hat
       now         welches Video gerade laeuft
       ready       jemand hat das laufende Video geladen
       settings    Einstellungen des Raumes, sobald jemand sie geaendert hat

     Client an Server
       pos, video, take, name, upload, upload-end, changed, now, ready,
       settings, bye

   Lautstaerke und Ton gehen bewusst nicht ueber die Leitung. Jeder regelt
   fuer sich, die Einstellung wird nie gesendet.

   Reisst die Verbindung ab, wird sie mit wachsendem Abstand neu aufgebaut.
   Danach kommt wieder ein "welcome" mit dem vollstaendigen Zustand.
   ========================================================================= */
(function (global) {
  "use strict";

  var WT = global.tk.weslie.WatchTogether;

  /* Takt aus der Planung. */
  var MASTER_MS = 2000;   /* der Taktgeber meldet seinen Zustand */
  var POS_MS    = 1000;   /* jeder meldet seine eigene Position  */
  var UPLOAD_MS = 2000;   /* laufende Uploads melden ihren Stand */

  var RETRY_MIN = 1000;
  var RETRY_MAX = 15000;

  /* Die Adresse kommt vom Server. Drei Faelle:
       leer      der Prozess lauscht selbst, auf seinem eigenen Port
       "/pfad"   er haengt hinter demselben Webserver, etwa im Container
       "ws://…"  vollstaendig vorgegeben */
  function endpoint(room, name) {
    var cfg = WT.api.settings().ws || {};
    var base = cfg.url;
    var scheme = global.location.protocol === "https:" ? "wss://" : "ws://";

    if (!base) {
      base = scheme + global.location.hostname + ":" + (cfg.port || 8081);
    } else if (base.charAt(0) === "/") {
      base = scheme + global.location.host + base;
    }

    return base +
      (base.indexOf("?") === -1 ? "?" : "&") +
      "room=" + encodeURIComponent(room) +
      "&name=" + encodeURIComponent(name);
  }

  /**
   * onMessage(type, data) bekommt jede Nachricht des Servers.
   * onState(state)        "open" | "lost" | "gone"
   */
  function connect(room, name, onMessage, onState) {
    var sock = null;
    var closed = false;      /* absichtlich beendet */
    var wait = RETRY_MIN;
    var timer = 0;
    var everOpen = false;

    var conn = {
      room: room,
      name: name,
      open: false
    };

    function open() {
      if (closed) return;
      try {
        sock = new global.WebSocket(endpoint(conn.room, conn.name));
      } catch (e) {
        retry();
        return;
      }

      sock.onopen = function () {
        conn.open = true;
        wait = RETRY_MIN;
        if (onState) onState(everOpen ? "back" : "open");
        everOpen = true;
      };

      sock.onmessage = function (e) {
        var msg = null;
        try { msg = JSON.parse(e.data); } catch (err) { return; }
        if (!msg || !msg.type) return;
        onMessage(msg.type, msg.data || {});
      };

      sock.onclose = function () {
        conn.open = false;
        sock = null;
        if (closed) return;
        if (onState) onState("lost");
        retry();
      };

      sock.onerror = function () {
        /* onclose kommt gleich hinterher und kuemmert sich um den Neuaufbau. */
      };
    }

    function retry() {
      if (closed || timer) return;
      timer = global.setTimeout(function () {
        timer = 0;
        open();
      }, wait);
      wait = Math.min(RETRY_MAX, Math.round(wait * 1.8));
    }

    conn.send = function (type, data) {
      if (!sock || sock.readyState !== 1) return false;
      try {
        sock.send(JSON.stringify({ type: type, data: data || {} }));
        return true;
      } catch (e) {
        return false;
      }
    };

    /* Nach einer Umbenennung soll auch ein Neuaufbau den neuen Namen tragen. */
    conn.rename = function (value) { conn.name = value; };

    conn.close = function () {
      closed = true;
      if (timer) { global.clearTimeout(timer); timer = 0; }
      if (sock && sock.readyState === 1) {
        conn.send("bye", {});
        try { sock.close(); } catch (e) { /* schon zu */ }
      }
      sock = null;
      conn.open = false;
    };

    open();
    return conn;
  }

  WT.net = {
    connect: connect,
    MASTER_MS: MASTER_MS,
    POS_MS: POS_MS,
    UPLOAD_MS: UPLOAD_MS
  };

})(window);
