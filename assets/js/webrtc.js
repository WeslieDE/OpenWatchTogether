/* ============================================================================
   tk.weslie.WatchTogether.webrtc

   Die Bildschirmuebertragung. Anders als net.js (Teilnehmer, Warteschlange,
   Zustand des Videos) geht es hier nur um zwei Rollen an der SFU-Verbindung:

     broadcast()   der Master schickt seinen Bildschirm hin
     watch()       alle anderen holen ihn sich ab

   Beide bauen dieselbe kleine Verhandlung mit mediasoup-client auf: erst die
   Codec-Angaben des Routers laden, dann einen Transport aufbauen, dann
   produzieren bzw. konsumieren. Reisst die Verbindung ab, wird sie mit
   wachsendem Abstand neu aufgebaut - dieselbe Art Rueckzug wie in net.js, nur
   dass hier die ganze Verhandlung von vorn beginnt: mediasoup kennt keinen
   Wiedereinstieg mitten in einem Transport.

   Der Sender braucht dafuer bei jedem (Wieder-)Aufbau ein frisches Token vom
   Haupt-Websocket - das SFU selbst kennt keine Auffrischung, das entscheidet
   allein Hub.php.

   Eine Bildschirmuebertragung mit Ton ist technisch zwei Producer (Bild und
   Ton je einer). Beim Zuschauen koennen ihre "new-producer"/"consumer-created"
   fast gleichzeitig hereinkommen - die Zuordnung laeuft deshalb ueber die
   Producer-Kennung, nicht ueber die Reihenfolge der Antworten.
   ========================================================================= */
(function (global) {
  "use strict";

  var WT = global.tk.weslie.WatchTogether;

  var RETRY_MIN = 1000;
  var RETRY_MAX = 15000;

  /* Drei Qualitaetsstufen fuer das Bild, gestaffelt in Aufloesung und
     Bitrate. mediasoup waehlt fuer jeden Zuschauer selbst und laufend die
     passende Stufe, je nachdem, was seine Leitung gerade traegt - wer knapp
     dran ist, bekommt ein kleineres, aber fluessiges Bild statt eines
     ruckelnden grossen. Der Ton bleibt unangetastet, er kostet ohnehin
     kaum etwas. */
  var VIDEO_ENCODINGS = [
    { scaleResolutionDownBy: 4, maxBitrate: 200000,  maxFramerate: 15 },
    { scaleResolutionDownBy: 2, maxBitrate: 700000,  maxFramerate: 24 },
    { scaleResolutionDownBy: 1, maxBitrate: 2500000, maxFramerate: 30 },
  ];

  function endpoint(room, peer, role, token) {
    var cfg = WT.api.settings().sfu || {};
    var base = cfg.url;
    var scheme = global.location.protocol === "https:" ? "wss://" : "ws://";

    if (!base) {
      base = scheme + global.location.hostname + ":" + (cfg.port || 8082);
    } else if (base.charAt(0) === "/") {
      base = scheme + global.location.host + base;
    }

    var q = "room=" + encodeURIComponent(room) +
      "&peer=" + encodeURIComponent(peer) +
      "&role=" + role;
    if (token) {
      q += "&exp=" + encodeURIComponent(token.exp) + "&sig=" + encodeURIComponent(token.sig);
    }
    return base + (base.indexOf("?") === -1 ? "?" : "&") + q;
  }

  /* --------------------------------------------------------- Signalisierung */
  /**
   * Eine einzelne WS-Verbindung mit drei Arten, an ihren Nachrichten
   * teilzuhaben:
   *   once(type)            naechste Nachricht dieser Art, einmalig
   *   onceForProducer(id)   naechste "consumer-created" zu genau dieser
   *                         Producer-Kennung - fuer Bild und Ton parallel
   *   setPush(fn)           alles andere (new-producer, producer-closed,
   *                         error) - kommt unaufgefordert vom Server
   */
  function channel(url) {
    var sock = new global.WebSocket(url);
    var waiters = {};       /* type => FIFO von Resolvern */
    var byProducer = {};    /* producerId => Resolver fuer consumer-created */
    var push = null;

    sock.onmessage = function (e) {
      var msg = null;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      if (!msg || !msg.type) return;
      var type = msg.type, data = msg.data || {};

      if (type === "consumer-created" && byProducer[data.producerId]) {
        var toProducer = byProducer[data.producerId];
        delete byProducer[data.producerId];
        toProducer(data);
        return;
      }
      if (waiters[type] && waiters[type].length) {
        waiters[type].shift()(data);
        return;
      }
      if (push) push(type, data);
    };

    return {
      raw: sock,
      once: function (type) {
        return new Promise(function (resolve) {
          (waiters[type] = waiters[type] || []).push(resolve);
        });
      },
      onceForProducer: function (producerId) {
        return new Promise(function (resolve) { byProducer[producerId] = resolve; });
      },
      setPush: function (fn) { push = fn; },
      send: function (type, data) {
        if (sock.readyState !== 1) return;
        try { sock.send(JSON.stringify({ type: type, data: data || {} })); } catch (e) { /* zu */ }
      },
      close: function () { try { sock.close(); } catch (e) { /* schon zu */ } }
    };
  }

  /* -------------------------------------------------------------- Zuschauen */

  /**
   * opts: { room, peer, onStream(stream), onState(state) }
   * state: "connecting" | "open" | "back" | "lost"
   * Rueckgabe: { close() }
   */
  function watch(opts) {
    var closed = false;
    var wait = RETRY_MIN;
    var timer = 0;
    var everOpen = false;
    var ch = null;
    var device = null;
    var recvTransport = null;
    var stream = new global.MediaStream();
    var known = {};             /* producerId => schon angefragt/konsumiert */
    var pending = [];           /* producerId, die vor dem Transport ankamen */

    opts.onStream(stream);

    function clearTracks() {
      stream.getTracks().forEach(function (t) { stream.removeTrack(t); });
      known = {};
      pending = [];
    }

    function scheduleRetry() {
      if (closed || timer) return;
      if (opts.onState) opts.onState("lost");
      timer = global.setTimeout(function () { timer = 0; open(); }, wait);
      wait = Math.min(RETRY_MAX, Math.round(wait * 1.8));
    }

    /* Zwischen dem Beitritt und dem fertigen Empfangs-Transport liegt eine
       kleine Verhandlung - meldet der Server in der Zeit schon einen
       Producer, wird er zwischengespeichert, statt verlorenzugehen. */
    function consume(producerId) {
      if (known[producerId]) return;
      known[producerId] = true;
      if (!recvTransport) { pending.push(producerId); return; }
      reallyConsume(producerId);
    }

    function reallyConsume(producerId) {
      var waitCreated = ch.onceForProducer(producerId);
      ch.send("consume", { producerId: producerId, rtpCapabilities: device.rtpCapabilities });

      waitCreated.then(function (data) {
        return recvTransport.consume({
          id: data.id, producerId: data.producerId, kind: data.kind, rtpParameters: data.rtpParameters
        });
      }).then(function (consumer) {
        stream.addTrack(consumer.track);
        ch.send("resume-consumer", { consumerId: consumer.id });
      }).catch(function () { /* der naechste Neuaufbau holt es nach */ });
    }

    function open() {
      if (closed) return;
      if (opts.onState) opts.onState("connecting");

      ch = channel(endpoint(opts.room, opts.peer, "consume", null));
      ch.setPush(function (type, data) {
        if (type === "new-producer") consume(data.producerId);
        else if (type === "producer-closed") clearTracks();
      });

      ch.raw.onclose = function () {
        if (closed) return;
        recvTransport = null;
        clearTracks();
        scheduleRetry();
      };
      ch.raw.onerror = function () { /* "close" kuemmert sich darum */ };

      ch.once("rtp-capabilities").then(function (data) {
        device = new global.mediasoupClient.Device();
        return device.load({ routerRtpCapabilities: data.rtpCapabilities });
      }).then(function () {
        ch.send("create-transport", { direction: "recv" });
        return ch.once("transport-created");
      }).then(function (data) {
        recvTransport = device.createRecvTransport({
          id: data.id, iceParameters: data.iceParameters,
          iceCandidates: data.iceCandidates, dtlsParameters: data.dtlsParameters
        });

        recvTransport.on("connect", function (p, callback) {
          ch.once("transport-connected").then(function () { callback(); });
          ch.send("connect-transport", { transportId: recvTransport.id, dtlsParameters: p.dtlsParameters });
        });
        recvTransport.on("connectionstatechange", function (state) {
          if (state === "failed" || state === "disconnected") ch.raw.close();
        });

        var queued = pending;
        pending = [];
        queued.forEach(reallyConsume);

        wait = RETRY_MIN;
        if (opts.onState) opts.onState(everOpen ? "back" : "open");
        everOpen = true;
      }).catch(function () { ch.raw.close(); });
    }

    open();

    return {
      close: function () {
        closed = true;
        if (timer) { global.clearTimeout(timer); timer = 0; }
        if (recvTransport) { try { recvTransport.close(); } catch (e) { /* zu */ } }
        recvTransport = null;
        clearTracks();
        if (ch) ch.close();
        ch = null;
      }
    };
  }

  /* --------------------------------------------------------------- Senden */

  /**
   * opts: { room, peer, stream, getToken(cb), onState(state) }
   * getToken ruft cb({exp, sig}) auf, sobald ueber den Haupt-Websocket ein
   * frisches Token da ist (Nachricht "live-start" -> "live-token").
   * state: "connecting" | "open" | "back" | "lost"
   * Rueckgabe: { close() }
   */
  function broadcast(opts) {
    var closed = false;
    var wait = RETRY_MIN;
    var timer = 0;
    var everOpen = false;
    var ch = null;
    var sendTransport = null;

    function scheduleRetry() {
      if (closed || timer) return;
      if (opts.onState) opts.onState("lost");
      timer = global.setTimeout(function () { timer = 0; open(); }, wait);
      wait = Math.min(RETRY_MAX, Math.round(wait * 1.8));
    }

    /* Bild und Ton (falls vorhanden) nacheinander, jeweils die Bestaetigung
       des Servers abwarten - dann braucht es keine eigene Zuordnung. */
    function produceTrack(track) {
      var opts = { track: track };
      if (track.kind === "video") {
        opts.encodings = VIDEO_ENCODINGS;
        opts.codecOptions = { videoGoogleStartBitrate: 1000 };
      }
      return sendTransport.produce(opts).then(function () {
        return ch.once("produced");
      });
    }

    function open() {
      if (closed) return;
      if (opts.onState) opts.onState("connecting");

      opts.getToken(function (token) {
        if (closed) return;

        var device = null;
        ch = channel(endpoint(opts.room, opts.peer, "produce", token));
        ch.setPush(function () { /* der Sender bekommt nichts Ungefragtes */ });

        ch.raw.onclose = function () {
          if (closed) return;
          sendTransport = null;
          scheduleRetry();
        };
        ch.raw.onerror = function () { /* "close" kuemmert sich darum */ };

        ch.once("rtp-capabilities").then(function (data) {
          device = new global.mediasoupClient.Device();
          return device.load({ routerRtpCapabilities: data.rtpCapabilities });
        }).then(function () {
          ch.send("create-transport", { direction: "send" });
          return ch.once("transport-created");
        }).then(function (data) {
          sendTransport = device.createSendTransport({
            id: data.id, iceParameters: data.iceParameters,
            iceCandidates: data.iceCandidates, dtlsParameters: data.dtlsParameters
          });

          sendTransport.on("connect", function (p, callback) {
            ch.once("transport-connected").then(function () { callback(); });
            ch.send("connect-transport", { transportId: sendTransport.id, dtlsParameters: p.dtlsParameters });
          });
          /* mediasoup-client will hier eine Producer-Kennung zurueck, um seinen
             lokalen Producer anzulegen - unser Protokoll ordnet Konsumenten
             aber ueber die vom Server vergebene Kennung zu (siehe "produced"),
             also reicht irgendeine eindeutige. */
          sendTransport.on("produce", function (p, callback) {
            ch.send("produce", { transportId: sendTransport.id, kind: p.kind, rtpParameters: p.rtpParameters });
            callback({ id: sendTransport.id + "-" + p.kind });
          });
          sendTransport.on("connectionstatechange", function (state) {
            if (state === "failed" || state === "disconnected") ch.raw.close();
          });

          var chain = Promise.resolve();
          opts.stream.getTracks().forEach(function (track) {
            chain = chain.then(function () { return produceTrack(track); });
          });
          return chain;
        }).then(function () {
          wait = RETRY_MIN;
          if (opts.onState) opts.onState(everOpen ? "back" : "open");
          everOpen = true;
        }).catch(function () { ch.raw.close(); });
      });
    }

    open();

    return {
      close: function () {
        closed = true;
        if (timer) { global.clearTimeout(timer); timer = 0; }
        if (sendTransport) { try { sendTransport.close(); } catch (e) { /* zu */ } }
        sendTransport = null;
        if (ch) ch.close();
        ch = null;
      }
    };
  }

  WT.webrtc = {
    watch: watch,
    broadcast: broadcast
  };

})(window);
