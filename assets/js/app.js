/* ============================================================================
   tk.weslie.WatchTogether.app

   Die Oberflaeche. Sie spricht ueber zwei Wege mit dem Server:

     tk.weslie.WatchTogether.net   die Live-Verbindung. Teilnehmer, Positionen,
                                   Zustand des Videos, laufende Uploads.
     tk.weslie.WatchTogether.api   gewoehnliches HTTP. Raum, Warteschlange,
                                   Upload, Loeschen.

   Lautstaerke, Ansicht und Name liegen im Browser und gehen niemanden sonst
   etwas an.
   ========================================================================= */
(function (global) {
  "use strict";

  var doc  = global.document;
  var WT   = global.tk.weslie.WatchTogether;
  var M    = WT.media;
  var api  = WT.api;
  var net  = WT.net;
  var i18n = WT.i18n;
  var names = WT.names;
  var t    = i18n.t;

  var tc = M.timecode;
  var clamp = M.clamp;

  /* ------------------------------------------------------------ Konstanten */

  var STORE_NAME  = "wt.name";
  var STORE_THEME = "wt.theme";
  var STORE_VOL   = "wt.volume";
  var STORE_MUTE  = "wt.muted";
  var STORE_WIDE  = "wt.wide";

  var SYNC_OK   = 0.4;    /* darunter gilt alles als gleich */
  var SYNC_HARD = 20;     /* darueber wird hart gesprungen  */
  var RATE_FAST = 1.2;
  var RATE_SLOW = 0.8;

  /* Nur Formate, die der Browser ohne Umwandlung abspielt. */
  var PLAYABLE = [
    { ext: "mp4",  mime: "video/mp4" },
    { ext: "m4v",  mime: "video/mp4" },
    { ext: "webm", mime: "video/webm" },
    { ext: "ogv",  mime: "video/ogg" },
    { ext: "ogg",  mime: "video/ogg" },
    { ext: "mov",  mime: "video/quicktime" }
  ];

  /* ---------------------------------------------------------------- State */

  var S = {
    room: null,
    conn: null,
    joined: false,
    me: { id: null, name: "", color: "#3f7d6e" },
    peers: [],                                  /* alle im Raum, mich eingeschlossen */
    masterId: null,
    remote: { playing: false, t: 0, at: 0 },    /* letzter Stand vom Taktgeber */
    remoteFresh: false,   /* gilt der Stand schon fuer das laufende Video? */
    told: false,          /* als Taktgeber den neuen Stand schon gemeldet?  */
    target: null,         /* zuletzt erwartete Zeit des Taktgebers */
    targetAt: 0,
    queue: [],
    /* Einstellungen des Raumes. Gelten fuer alle und kommen vom Server. */
    settings: { keep: false, opening: 0, ending: 0 },
    pending: [],          /* laufende Uploads, eigene und fremde */
    jobs: [],             /* eigene Uploads mit Datei und Fortschritt */
    current: null,
    nowId: null,
    waiting: null,        /* auf dieses Video warten noch Teilnehmer */
    correcting: 0,
    silentTake: false,
    seq: 100
  };

  function now() { return global.performance.now(); }

  /* ------------------------------------------------------------------ DOM */

  function $(id) { return doc.getElementById(id); }

  var el = {
    veilRoom: $("veilRoom"), formRoom: $("formRoom"), inpRoom: $("inpRoom"),
    errRoom: $("errRoom"), roomSuggestRow: $("roomSuggestRow"), btnRoomMore: $("btnRoomMore"),

    veilName: $("veilName"), formName: $("formName"), inpName: $("inpName"),
    errName: $("errName"), nameTitle: $("nameTitle"), nameLead: $("nameLead"),
    btnNameCancel: $("btnNameCancel"), btnNameSave: $("btnNameSave"),
    nameSuggestRow: $("nameSuggestRow"), btnNameMore: $("btnNameMore"),

    veilLink: $("veilLink"), linkLead: $("linkLead"),

    veilSettings: $("veilSettings"), formSettings: $("formSettings"),
    setKeep: $("setKeep"), setOpening: $("setOpening"), setEnding: $("setEnding"),
    errSettings: $("errSettings"), btnSettings: $("btnSettings"),
    btnSetClose: $("btnSetClose"), btnSetCancel: $("btnSetCancel"),

    veilUpload: $("veilUpload"), upPick: $("upPick"), upRun: $("upRun"), upDone: $("upDone"),
    drop: $("drop"), inpFile: $("inpFile"), errFile: $("errFile"),
    upList: $("upList"), upBar: $("upBar"),
    upPct: $("upPct"), upSpeed: $("upSpeed"), upEta: $("upEta"),
    btnUpMin: $("btnUpMin"), btnUpMin2: $("btnUpMin2"), btnUpClose: $("btnUpClose"),
    btnUpAbort: $("btnUpAbort"), btnUpFinish: $("btnUpFinish"), doneText: $("doneText"),


    app: $("app"),
    roomName: $("roomName"), btnCopyLink: $("btnCopyLink"),
    btnAdd: $("btnAdd"), btnAddEmpty: $("btnAddEmpty"), btnAddQueue: $("btnAddQueue"),
    btnTheme: $("btnTheme"), btnRename: $("btnRename"),
    meAvatar: $("meAvatar"), meName: $("meName"),

    stage: $("stage"), video: $("video"),
    stageEmpty: $("stageEmpty"), stageTap: $("stageTap"), stageStart: $("stageStart"),
    btnBigPlay: $("btnBigPlay"), badgeSync: $("badgeSync"), badgeLink: $("badgeLink"),
    badgeWait: $("badgeWait"), badgeWaitText: $("badgeWaitText"),

    controls: $("controls"), btnPlay: $("btnPlay"), tCur: $("tCur"), tDur: $("tDur"),
    btnBack10: $("btnBack10"), btnFwd10: $("btnFwd10"),
    scrub: $("scrub"), scrubFill: $("scrubFill"), scrubKnob: $("scrubKnob"),
    scrubPeers: $("scrubPeers"), scrubHint: $("scrubHint"),
    btnMute: $("btnMute"), volRange: $("volRange"),
    btnWide: $("btnWide"), btnFull: $("btnFull"),

    now: $("now"), nowTitle: $("nowTitle"), nowBy: $("nowBy"), btnTakeover: $("btnTakeover"),

    logRows: $("logRows"), logCount: $("logCount"),

    viewerRows: $("viewerRows"), viewerCount: $("viewerCount"),
    queue: $("queue"), queueCount: $("queueCount"), queueEmpty: $("queueEmpty"),

    mini: $("mini"), miniName: $("miniName"), miniBar: $("miniBar"),
    miniPct: $("miniPct"), miniEta: $("miniEta"), btnMiniOpen: $("btnMiniOpen"),

    toasts: $("toasts")
  };

  var surface = new M.Surface(el.video);

  /* --------------------------------------------------------------- Utils */

  function initials(name) {
    var parts = String(name).trim().split(/\s+/);
    if (!parts[0]) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  function bytes(n) {
    if (n >= 1073741824) return num(n / 1073741824, 2) + " GB";
    if (n >= 1048576) return Math.round(n / 1048576) + " MB";
    return Math.max(1, Math.round(n / 1024)) + " KB";
  }

  function num(v, digits) {
    var s = v.toFixed(digits);
    return i18n.get() === "de" ? s.replace(".", ",") : s;
  }

  function slugify(v) {
    return String(v).toLowerCase().trim()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9äöüß\-]/g, "")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  }

  function icon(id) { return '<svg><use href="#' + id + '"/></svg>'; }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function toast(text, iconId) {
    var node = doc.createElement("div");
    node.className = "toast";
    node.innerHTML = (iconId ? icon(iconId) : "") + "<span>" + esc(text) + "</span>";
    el.toasts.appendChild(node);
    global.setTimeout(function () {
      node.classList.add("is-leaving");
      global.setTimeout(function () { node.remove(); }, 300);
    }, 3200);
  }

  function openVeil(node, focusNode) {
    node.hidden = false;
    if (focusNode) global.setTimeout(function () { focusNode.focus(); }, 40);
  }
  function closeVeil(node) { node.hidden = true; }

  function veilOpen() {
    return !(el.veilRoom.hidden && el.veilName.hidden && el.veilUpload.hidden &&
             el.veilLink.hidden && el.veilSettings.hidden);
  }

  function store(key, value) {
    try { global.localStorage.setItem(key, value); } catch (e) { /* ohne Speicher weiter */ }
  }
  function stored(key) {
    try { return global.localStorage.getItem(key); } catch (e) { return null; }
  }

  /* ------------------------------------------------------------ Teilnehmer */

  function peerById(id) {
    for (var i = 0; i < S.peers.length; i++) if (S.peers[i].id === id) return S.peers[i];
    return null;
  }
  function isMaster() { return S.masterId && S.masterId === S.me.id; }

  /* Laeuft das Video gerade? Als Taktgeber zaehlt der eigene Player. */
  function playingNow() {
    return isMaster() ? (surface.ready && !surface.paused) : S.remote.playing;
  }

  /* Zeit des Taktgebers, zwischen zwei Meldungen hochgerechnet. */
  function masterTime() {
    if (isMaster()) return surface.position;
    var v = S.remote;
    var tt = v.playing ? v.t + (now() - v.at) / 1000 : v.t;
    return clamp(tt, 0, surface.length || tt);
  }

  /* Position eines Teilnehmers, ebenfalls hochgerechnet. */
  function peerTime(p) {
    if (p.isMe) return surface.position;
    if (p.id === S.masterId) return masterTime();
    var tt = p.t + (playingNow() ? (now() - p.at) / 1000 : 0);
    return clamp(tt, 0, surface.length || tt);
  }

  function toPeer(raw) {
    return {
      id: raw.id, name: raw.name, color: raw.color,
      isMe: raw.id === S.me.id, t: 0, at: now(),
      /* Welches Video dieser Teilnehmer geladen hat. Wer eben erst
         dazugekommen ist, hat noch keines. */
      ready: raw.ready || null
    };
  }

  function sortPeers() {
    /* Sich selbst zuerst zeigen, danach die Reihenfolge des Beitritts. */
    S.peers.sort(function (a, b) { return (b.isMe ? 1 : 0) - (a.isMe ? 1 : 0); });
  }

  /* -------------------------------------------------- Nachrichten empfangen */

  function onMessage(type, d) {
    switch (type) {

      /* Kompletter Raumzustand beim Verbinden. Kommt nach einem Abriss
         erneut, dann wird der Stand einfach ersetzt. */
      case "welcome":
        S.me.id = d.you.id;
        S.me.name = d.you.name;
        S.me.color = d.you.color;
        store(STORE_NAME, S.me.name);
        S.peers = (d.peers || []).map(toPeer);
        sortPeers();
        S.masterId = d.master;
        S.remote = { playing: d.video.playing, t: d.video.t, at: now() };
        S.pending = (d.uploads || []).slice();
        S.queue = (d.queue || []).slice();
        S.settings = cleanSettings(d.settings);
        S.nowId = d.now || null;
        enterApp();
        /* Der mitgeschickte Stand gehoert zum mitgeschickten Video. */
        S.remoteFresh = true;
        /* Der Raum war leer und stand mitten im Video. Wer ihn aufweckt,
           setzt es zurueck an diese Stelle, sobald es geladen ist. */
        if (d.resume > 0 && S.current) resumeTo = d.resume;
        break;

      case "joined":
        if (!peerById(d.id)) {
          S.peers.push(toPeer(d));
          renderViewers();
          toast(t("toast.peerJoined", { name: d.name }), "i-users");
        }
        break;

      case "left":
        var gone = peerById(d.id);
        if (gone) {
          S.peers = S.peers.filter(function (p) { return p.id !== d.id; });
          renderViewers();
          toast(t("toast.peerLeft", { name: gone.name }), "i-users");
        }
        break;

      case "named":
        var np = peerById(d.id);
        if (np) np.name = d.name;
        S.queue.forEach(function (item) {
          if (item.addedById === d.id) item.addedBy = d.name;
        });
        S.pending.forEach(function (up) {
          if (up.byId === d.id) up.by = d.name;
        });
        renderViewers();
        renderQueue();
        if (S.current) el.nowBy.textContent = byLine(S.current, "now.by");
        break;

      case "master":
        S.masterId = d.id;
        S.correcting = 0;
        S.target = null;               /* neuer Takt, alter Verlauf zaehlt nicht */
        surface.rate = 1;
        el.badgeSync.hidden = true;
        renderViewers();
        renderTakeover();
        if (d.id === S.me.id) {
          if (!S.silentTake) toast(t("toast.youControl"), "i-crown");
          S.silentTake = false;
        } else {
          var mp = peerById(d.id);
          if (mp) toast(t("toast.peerControl", { name: mp.name }), "i-crown");
        }
        break;

      /* Zustand vom Taktgeber, laut Planung alle 2 Sekunden. */
      case "video":
        if (isMaster()) break;                 /* eigener Zustand zaehlt */
        var ran = S.remote.playing;
        S.remote = { playing: !!d.playing, t: d.t || 0, at: now() };
        S.remoteFresh = true;
        if (S.remote.playing !== ran) notePlay(S.remote.playing, S.masterId);
        break;

      /* Welches Video laeuft. Gibt der Taktgeber vor. */
      case "now":
        S.nowId = d.id || null;
        if (!isMaster()) applyNow(S.nowId);
        break;

      /* Die Warteschlange hat sich geaendert. */
      case "queue":
        applyQueue(d.items || []);
        break;

      /* Jemand hat an den Raumeinstellungen gedreht. Sie gelten fuer alle,
         also kommt der neue Stand auch bei dem an, der ihn geschickt hat. */
      case "settings":
        S.settings = cleanSettings(d);
        logAdd("log.settings", "", logWho(d.byId, d.by));
        toast(d.byId === S.me.id
          ? t("toast.settingsSaved")
          : t("toast.settings", { name: d.by }), "i-sliders");
        break;

      /* Jemand laedt etwas hoch. Der Eintrag steht sofort in der Liste. */
      case "upload":
        var up = pendingById(d.id);
        if (up) {
          up.pct = d.pct;
          up.title = d.title;
          paintPending();
        } else {
          S.pending.push({ id: d.id, byId: d.byId, by: d.by, title: d.title, pct: d.pct });
          renderQueue();
        }
        break;

      /* Fertig oder abgebrochen. Abgebrochenes verschwindet wieder. Was fertig
         ist, kommt gleich darauf als frische Warteschlange herein. */
      case "upload-end":
        /* Der Eintrag traegt den Absender schon mit sich. Was durch ist,
           steht gleich darauf in der frischen Warteschlange. */
        var fin = pendingById(d.id);
        if (fin && d.ok) logAdd("log.add", fin.title, logWho(fin.byId, fin.by));
        dropPending(d.id);
        break;

      /* Jemand hat das Video im Puffer. Ob damit alle so weit sind, sieht der
         Taktgeber im naechsten Durchlauf. */
      case "ready":
        var rp = peerById(d.id);
        if (rp) rp.ready = d.item || null;
        break;

      /* Positionen der anderen Teilnehmer. */
      case "pos":
        var stamp = now();
        Object.keys(d).forEach(function (id) {
          var p = peerById(id);
          if (p && !p.isMe) { p.t = d[id]; p.at = stamp; }
        });
        break;
    }
  }

  /* Zustand der Leitung. */
  function onLinkState(state) {
    if (state === "open" || state === "back") {
      el.badgeLink.hidden = true;
      if (state === "back") toast(t("toast.linkBack"), "i-check");
      return;
    }
    /* Verloren. Der Neuaufbau laeuft in net.js weiter. */
    if (S.joined) {
      el.badgeLink.hidden = false;
      toast(t("toast.linkLost"));
    } else {
      el.linkLead.textContent = t("link.retry");
    }
  }

  /* -------------------------------------------------- Nachrichten senden -- */

  function send(type, data) {
    return S.conn ? S.conn.send(type, data) : false;
  }

  function sendPos() {
    if (surface.settled) send("pos", { t: surface.position });
  }

  /* Der Taktgeber meldet Spielt/Pausiert samt Zeit: bei jeder Aenderung und
     zusaetzlich im festen Takt. */
  function sendVideo() {
    if (!isMaster() || !surface.settled) return;
    send("video", { playing: !surface.paused, t: surface.position });
  }

  function sendNow() {
    if (!isMaster()) return;
    send("now", { id: S.current ? S.current.id : "" });
  }

  function takeControl(silent) {
    if (isMaster()) return;
    S.silentTake = !!silent;
    S.masterId = S.me.id;              /* sofort, die Bestaetigung folgt */
    S.correcting = 0;
    S.target = null;
    surface.rate = 1;
    el.badgeSync.hidden = true;
    renderViewers();
    renderTakeover();
    send("take", {});
  }

  /* --------------------------------------------------------------- Player */

  function itemById(id) {
    if (!id) return null;
    for (var i = 0; i < S.queue.length; i++) if (S.queue[i].id === id) return S.queue[i];
    return null;
  }

  /* Welches Video laeuft: was der Taktgeber vorgibt, sonst der Kopf der Liste. */
  var stageReady = false;

  function applyNow(id) {
    var item = itemById(id) || S.queue[0] || null;
    if (stageReady) {
      if (S.current && item && S.current.id === item.id) return;
      if (!S.current && !item) return;
    }
    stageReady = true;
    loadItem(item);
  }

  function loadItem(item) {
    /* Ein Wechsel geht auf das Konto des Taktgebers: entweder hat er gerade
       umgeschaltet, oder ich selbst habe den Takt dafuer uebernommen. Der
       erste Aufbau nach dem Beitritt ist kein Wechsel. */
    var left = S.current;
    if (left && (!item || left.id !== item.id)) {
      noteLeft(left.id);
      if (item) logAdd("log.switch", item.title, logWho(S.masterId));
    }

    /* Genau dieser Wechsel ist es, auf den der Raum gemeinsam wartet. Das
       erste Video nach dem Beitritt und das erste im leeren Raum sind kein
       Wechsel und starten wie bisher von Hand. */
    var switched = !!(left && item && left.id !== item.id);
    if (switched) beginWait(item.id);
    else endWait();

    S.current = item || null;
    S.correcting = 0;
    el.badgeSync.hidden = true;

    /* Der letzte Stand des Taktgebers gehoert zum vorigen Video und taugt
       nicht mehr zum Angleichen. Bis seine erste Meldung zum neuen Video da
       ist, wird nicht nachgeregelt. Dass es dabei kurz auseinanderlaeuft,
       ist gewollt und keine Sache fuer den Hinweis. */
    S.remoteFresh = false;
    S.told = false;
    S.target = null;
    resumeTo = 0;                      /* eine alte Stelle gilt nicht mehr */
    startAt = 0;
    endedAt = "";

    if (!item) {
      surface.unload();
      el.stageEmpty.hidden = false;
      el.stageTap.hidden = true;
      el.stageStart.hidden = true;
      el.controls.dataset.idle = "1";
      el.nowTitle.textContent = t("now.empty");
      el.nowBy.textContent = "";
      el.tCur.textContent = "0:00";
      el.tDur.textContent = "0:00";
      el.scrubFill.style.width = "0%";
      el.scrubKnob.style.left = "0%";
      el.scrubPeers.innerHTML = "";
      renderQueue();
      renderTakeover();
      sendNow();
      return;
    }

    surface.load(item);

    /* Hinter dem Vorspann anfangen. Das gilt nur beim Wechsel: wer mitten in
       einen laufenden Raum kommt, soll nicht nach vorn gerissen werden. Der
       Taktgeber springt, die anderen kommen ueber seinen Stand mit. */
    if (switched && isMaster()) startAt = openingOf(item);

    surface.volume = el.volRange.value / 100;
    surface.muted = el.btnMute.classList.contains("is-muted");
    el.stageEmpty.hidden = true;
    el.stageTap.hidden = false;
    el.controls.dataset.idle = "";
    el.nowTitle.textContent = item.title;
    el.nowBy.textContent = byLine(item, "now.by");
    el.tDur.textContent = tc(item.duration || 0);

    /* Angespielt wird hier nichts. Entweder wartet der Raum noch auf die
       anderen, oder jemand drueckt selbst auf Start. */
    sendNow();
    if (isMaster()) sendVideo();

    updatePlayUi();
    renderQueue();
    renderTakeover();
  }

  function addedName(item) {
    return item.addedById === S.me.id ? S.me.name : item.addedBy;
  }

  /* Wer hat es mitgebracht? Hinter jedem Video steht jemand, der es
     hochgeladen hat. */
  function byLine(item, key) {
    return t(key, { name: addedName(item) });
  }

  /* Von Hand gestartet oder angehalten. Beides sticht das Warten auf die
     anderen aus: wer drueckt, will nicht warten. */
  function doPlay() {
    if (!surface.ready) return;
    takeControl(true);
    endWait();
    surface.play();
    notePlay(true, S.me.id);
    sendVideo();
    updatePlayUi();
  }

  function doPause() {
    if (!surface.ready) return;
    takeControl(true);
    endWait();
    surface.pause();
    notePlay(false, S.me.id);
    sendVideo();
    updatePlayUi();
  }

  function togglePlay() { surface.paused ? doPlay() : doPause(); }

  /* Ein Stueck vor oder zurueck. Wie jedes Spulen gilt es fuer alle, also
     uebernimmt der Springende den Takt. */
  var SKIP = 10;

  function skip(by) {
    if (!surface.ready) return;
    doSeek(clamp(surface.position + by, 0, surface.length || 0));
  }

  function doSeek(tt) {
    if (!surface.ready) return;
    takeControl(true);
    surface.seek(tt);
    sendVideo();
    updateScrub();
  }

  function updatePlayUi() {
    var playing = surface.ready && !surface.paused;
    el.btnPlay.classList.toggle("is-playing", playing);
    el.btnPlay.setAttribute("title", t(playing ? "ctl.pause" : "ctl.play"));
    el.stageStart.hidden = !(surface.ready && !playing);
  }

  /* Durchgelaufen: der Taktgeber raeumt das Video weg und geht weiter. Die
     anderen bekommen die neue Liste und das neue "now" ueber die Verbindung.

     Soll der Raum seine Videos behalten, wird nichts geloescht. Dann rueckt
     nur das naechste nach, und die Liste faengt hinten wieder von vorne an.
     Liegt gar nichts anderes da, bleibt das Video am Ende stehen. */
  function onEnded() {
    var done = S.current;
    if (!done || !isMaster()) return;

    var idx = S.queue.indexOf(done);
    var next = S.queue[idx + 1] || S.queue[0] || null;
    if (next === done) next = null;

    toast(t("toast.finished", { title: done.title }), "i-check");

    if (S.settings.keep) {
      if (!next) {
        surface.pause();
        notePlay(false, S.me.id);
        sendVideo();
        updatePlayUi();
        return;
      }
      loadItem(next);
      toast(t("toast.next", { title: next.title }), "i-queue");
      return;
    }

    dropLocal(done.id);
    loadItem(next);
    if (next) toast(t("toast.next", { title: next.title }), "i-queue");

    /* Die Datei wird auf dem Server geloescht, sobald sie durch ist. */
    api.remove(S.room, done.id).then(function () {
      send("changed", {});
    }, function () { /* das Aufraeumen holt es spaetestens nach */ });
  }

  surface.onEnded = onEnded;

  surface.onBlocked = function () {
    /* Ohne vorherige Bedienung darf der Browser das Abspielen ablehnen. */
    updatePlayUi();
    toast(t("toast.blocked"), "i-play");
  };

  /* --------------------------------------------------------- Gemeinsam los */

  /* Ein anderes Video liegt an. Alle laden es erst einmal, und wer so weit
     ist, sagt Bescheid. Sobald es bei allen im Puffer liegt, laesst der
     Taktgeber es losgehen - dann faengt niemand mitten im Vorspann an.

     Warten muss niemand: der grosse Knopf startet sofort, egal wie weit die
     anderen sind. Genauso beendet ein Druck auf Pause das Warten. */

  var toldReady = "";      /* fuer welches Video ich "geladen" gemeldet habe */

  /* Der Wechsel ist durch, das Warten beginnt. Was vorher geladen war, zaehlt
     nicht mehr; der Server raeumt es beim "now" ebenso weg. */
  function beginWait(id) {
    S.waiting = id;
    toldReady = "";
    S.peers.forEach(function (p) { p.ready = null; });
  }

  function endWait() {
    S.waiting = null;
    el.badgeWait.hidden = true;
  }

  /* Liegt es hier im Puffer, erfahren es die anderen. Einmal je Video. */
  function tellReady() {
    var id = S.current ? S.current.id : "";
    if (!id || toldReady === id || !surface.playable) return;
    if (!send("ready", { item: id })) return;   /* ohne Leitung spaeter erneut */
    toldReady = id;
    var me = peerById(S.me.id);
    if (me) me.ready = id;
  }

  function readyCount() {
    var n = 0;
    S.peers.forEach(function (p) { if (p.ready === S.waiting) n++; });
    return n;
  }

  /* Alle so weit? Dann geht es los. Diese Entscheidung faellt allein beim
     Taktgeber, die anderen kommen ueber seine Meldung mit. */
  function startWhenAllReady() {
    if (!S.waiting || !isMaster()) return;
    if (!S.current || S.current.id !== S.waiting) return;
    if (readyCount() < S.peers.length) return;
    endWait();
    surface.play();
    notePlay(true, S.me.id);
    sendVideo();
    updatePlayUi();
  }

  function updateWait() {
    /* Laeuft es schon, oder liegt laengst ein anderes Video an, ist das
       Warten vorbei. Der Stand des Taktgebers gehoert dabei erst dann hierher,
       wenn er sich auf das neue Video bezieht - sonst zaehlt noch das
       "spielt" des vorigen. */
    var running = isMaster()
      ? (surface.ready && !surface.paused)
      : (S.remoteFresh && S.remote.playing);

    if (S.waiting && (running || !S.current || S.current.id !== S.waiting)) {
      endWait();
    }
    if (!S.waiting) return;
    el.badgeWait.hidden = false;
    el.badgeWaitText.textContent =
      t("stage.wait", { n: readyCount(), total: S.peers.length });
  }

  /* ------------------------------------------------------------- Abgleich */

  /* Stelle aus einem wieder erwachten Raum. Springen laesst sich erst, wenn
     das Video geladen ist, also wartet sie hier auf ihren Augenblick. */
  var resumeTo = 0;

  function resumeTick() {
    if (!resumeTo) return;
    if (!isMaster()) { resumeTo = 0; return; }   /* ein anderer gibt den Takt vor */
    if (!surface.settled) return;
    surface.seek(resumeTo);
    resumeTo = 0;
    updateScrub();
  }

  /* ------------------------------------------------ Vorspann und Abspann */

  /* Zwei Marken des Raumes. Der Vorspann sagt, wo ein frisch gewechseltes
     Video anfangen soll; der Abspann, ab wann es als durch gilt. Beides
     entscheidet allein der Taktgeber - die anderen kommen ueber seinen Stand
     mit, wie bei jedem Sprung. Ohne Angaben bleibt alles beim Alten. */

  var startAt = 0;      /* Stelle, an der das neue Video anfangen soll */
  var endedAt = "";     /* fuer welches Video schon Schluss gemeldet wurde */

  /* Ein Vorspann, der laenger ist als das Video selbst, waere kein Vorspann. */
  function openingOf(item) {
    var at = S.settings.opening;
    var len = item.duration || 0;
    if (at <= 0) return 0;
    return len > 0 && at >= len - 1 ? 0 : at;
  }

  function startTick() {
    if (!startAt) return;
    /* Eine gemerkte Stelle aus dem wieder erwachten Raum sticht den Vorspann
       aus: dort wurde ja schon einmal weitergeschaut. */
    if (resumeTo || !isMaster()) { startAt = 0; return; }
    if (!surface.settled) return;

    surface.seek(startAt);
    startAt = 0;
    sendVideo();
    updateScrub();
  }

  /* Am Abspann angekommen: das zaehlt wie durchgelaufen. Im Stehen wird nicht
     geschaltet, sonst reisst schon ein Blick ans Ende das Video weg. */
  function endingTick() {
    if (!isMaster() || !S.current || !surface.settled || surface.paused) return;
    if (endedAt === S.current.id) return;

    var before = S.settings.ending;
    var len = surface.length;
    if (before <= 0 || !len || before >= len) return;
    if (surface.position < len - before) return;

    endedAt = S.current.id;
    onEnded();
  }

  /* Der Taktgeber meldet den neuen Stand, sobald das frisch geladene Video
     steht. Ohne das haengen die anderen bis zur naechsten festen Meldung noch
     am vorigen Video. */
  function tellSettled() {
    if (!surface.settled) { S.told = false; return; }
    if (S.told) return;
    S.told = true;
    sendVideo();
  }

  function syncTick() {
    resumeTick();
    if (isMaster()) { tellSettled(); return; }
    if (!surface.settled) return;

    /* Solange der Stand noch zum vorigen Video gehoert, wird nichts gerichtet. */
    if (!S.remoteFresh) return;

    var target = masterTime();
    var stamp = now();

    /* Ist der Taktgeber selbst gesprungen (neues Video, Spulen), liegt der
       Abstand nicht am eigenen Player. Dann wird still nachgezogen. */
    var expected = S.target === null ? null
      : S.target + (S.remote.playing ? (stamp - S.targetAt) / 1000 : 0);
    var jumped = expected === null || Math.abs(target - expected) > SYNC_HARD;
    S.target = target;
    S.targetAt = stamp;

    /* Spielt oder pausiert wird uebernommen. */
    if (S.remote.playing && surface.paused) { surface.play(); updatePlayUi(); }
    if (!S.remote.playing && !surface.paused) { surface.pause(); updatePlayUi(); }

    var diff = target - surface.position;
    var a = Math.abs(diff);

    if (!S.remote.playing) {
      /* Steht das Video, laesst sich nichts angleichen. Dann still setzen. */
      if (a > SYNC_OK) surface.seek(target);
      if (S.correcting !== 0) { S.correcting = 0; surface.rate = 1; el.badgeSync.hidden = true; }
      return;
    }

    if (a > SYNC_HARD) {
      surface.seek(target);
      surface.rate = 1;
      S.correcting = 0;
      el.badgeSync.hidden = true;
      if (!jumped) noteSync();
    } else if (a > SYNC_OK) {
      var dir = diff > 0 ? 1 : -1;
      if (S.correcting !== dir) {
        S.correcting = dir;
        surface.rate = dir > 0 ? RATE_FAST : RATE_SLOW;
        el.badgeSync.hidden = false;
      }
    } else if (S.correcting !== 0) {
      S.correcting = 0;
      surface.rate = 1;
      el.badgeSync.hidden = true;
    }
  }

  var syncNotedAt = 0;
  function noteSync() {
    var stamp = Date.now();
    if (stamp - syncNotedAt < 4000) return;
    syncNotedAt = stamp;
    toast(t("toast.synced"), "i-users");
  }

  /* ------------------------------------------------------------ Protokoll */

  /* Was im Raum vorgeht, steht untereinander unter dem Video. Der Verlauf
     liegt allein im Browser: nichts davon geht an den Server, nichts
     ueberlebt das Neuladen der Seite. Zu sehen ist nur, was seit dem eigenen
     Beitritt geschehen ist.

     Woher die Angaben kommen: eigene Handgriffe tragen sich selbst ein, alles
     andere wird aus den Nachrichten der Verbindung gelesen. Starten, Anhalten
     und Wechseln kommt vom Taktgeber, ein fertiger Upload bringt seinen
     Absender schon mit. Nur beim Entfernen sagt die Leitung nicht, wer es
     war - dann bleibt die Spalte leer. */

  var LOG_MAX = 200;
  var logbook = [];

  /* Wer war es? Der Teilnehmer, wie er jetzt heisst, sonst der mitgereichte
     Name. Was einmal im Protokoll steht, aendert sich spaeter nicht mehr. */
  function logWho(id, fallback) {
    var p = id ? peerById(id) : null;
    if (p) return { id: p.id, name: p.name, color: p.color };
    if (id === S.me.id) return { id: id, name: S.me.name, color: S.me.color };
    if (fallback) return { id: id, name: fallback, color: "#86868f" };
    return null;
  }

  function logAdd(key, title, who) {
    logbook.unshift({ at: new Date(), key: key, title: title || "", who: who || null });
    if (logbook.length > LOG_MAX) logbook.length = LOG_MAX;
    renderLog();
  }

  /* Stunde, Minute, Sekunde. In beiden Sprachen mit 24 Stunden, damit die
     Spalte schmal bleibt. */
  function logTime(when) {
    return when.toLocaleTimeString(i18n.get() === "de" ? "de-DE" : "en-GB",
      { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function renderLog() {
    el.logCount.textContent = String(logbook.length);

    if (!logbook.length) {
      el.logRows.innerHTML = '<tr class="log-none"><td colspan="3">' +
        esc(t("log.empty")) + "</td></tr>";
      return;
    }

    el.logRows.innerHTML = logbook.map(function (entry) {
      var who = entry.who
        ? '<span class="v-who">' +
            '<span class="avatar" style="background:' + esc(entry.who.color) + '">' +
              esc(initials(entry.who.name)) + "</span>" +
            '<span class="v-name">' + esc(entry.who.name) + "</span>" +
            (entry.who.id === S.me.id
              ? '<span class="v-you">' + esc(t("viewers.you")) + "</span>" : "") +
          "</span>"
        : '<span class="log-nobody">–</span>';

      return "<tr>" +
        '<td class="log-at mono">' + esc(logTime(entry.at)) + "</td>" +
        '<td class="log-what">' + esc(t(entry.key, { title: entry.title })) + "</td>" +
        "<td>" + who + "</td>" +
      "</tr>";
    }).join("");
  }

  /* Start und Pause werden erst nach einer kurzen Ruhe vermerkt. Beim Wechsel
     auf ein anderes Video zuckt der Zustand einmal hin und zurueck, weil das
     frisch geladene Video kurz steht. Das gehoert nicht ins Protokoll. */
  var playShown = false;    /* zuletzt eingetragener Zustand */
  var playTimer = 0;
  var playBy = null;

  function notePlay(playing, byId) {
    playBy = byId;
    if (playTimer) global.clearTimeout(playTimer);
    playTimer = global.setTimeout(function () {
      playTimer = 0;
      if (playing === playShown) return;
      playShown = playing;
      logAdd(playing ? "log.play" : "log.pause", "", logWho(playBy));
    }, 1600);
  }

  /* Zuletzt verlassenes Video. Es verschwindet gleich darauf aus der
     Warteschlange, wenn es durchgelaufen ist. Das ist kein Entfernen. */
  var leftId = "";
  var leftAt = 0;

  function noteLeft(id) {
    leftId = id;
    leftAt = Date.now();
  }

  /* Eintraege, die aus der Warteschlange verschwunden sind. Eigenes Entfernen
     steht zu diesem Zeitpunkt laengst im Protokoll und ist auch schon aus der
     eigenen Liste raus, taucht hier also nicht mehr auf. */
  function noteGone(items) {
    if (!S.joined) return;
    var still = {};
    var here = S.current ? S.current.id : "";
    items.forEach(function (item) { still[item.id] = true; });
    S.queue.forEach(function (old) {
      if (still[old.id]) return;
      /* Das laufende und das eben verlassene Video verschwinden auch dann aus
         der Liste, wenn sie einfach durchgelaufen sind. Ob jemand nachgeholfen
         hat, sagt die Leitung nicht. Also lieber kein Eintrag als ein
         falscher. */
      if (old.id === here) return;
      if (old.id === leftId && Date.now() - leftAt < 8000) return;
      logAdd("log.del", old.title, null);
    });
  }

  /* ------------------------------------------------------------- Rendering */

  function updateScrub() {
    var len = surface.length || 0;
    var pos = surface.position || 0;
    var pct = len ? (pos / len) * 100 : 0;
    el.scrubFill.style.width = pct + "%";
    el.scrubKnob.style.left = pct + "%";
    el.tCur.textContent = tc(pos);
    el.tDur.textContent = tc(len);
  }

  function renderPeerTicks() {
    var len = surface.length || 0;
    var row = el.scrubPeers;
    if (!len) { row.innerHTML = ""; return; }

    /* Marken nur fuer die anderen, meine Position zeigt der Regler selbst. */
    var others = S.peers.filter(function (p) { return !p.isMe; });
    while (row.children.length > others.length) row.removeChild(row.lastChild);
    while (row.children.length < others.length) {
      var d = doc.createElement("i");
      d.className = "peer-tick";
      row.appendChild(d);
    }
    others.forEach(function (p, i) {
      var node = row.children[i];
      node.style.left = clamp((peerTime(p) / len) * 100, 0, 100) + "%";
      node.style.background = p.color;
      node.title = p.name;
    });
  }

  function renderViewers() {
    var rows = "";
    S.peers.forEach(function (p) {
      var cls = p.id === S.masterId ? "is-master" : "";
      rows += '<tr class="' + cls + '">' +
        '<td><span class="v-who">' +
          '<span class="avatar" style="background:' + p.color + '">' + esc(initials(p.name)) + "</span>" +
          '<span class="v-name">' + esc(p.name) + "</span>" +
          (p.isMe ? '<span class="v-you">' + esc(t("viewers.you")) + "</span>" : "") +
          '<span class="v-crown" title="' + esc(t("viewers.master")) + '">' + icon("i-crown") + "</span>" +
        "</span></td>" +
        '<td class="v-pos">' + tc(peerTime(p)) + "</td>" +
      "</tr>";
    });
    el.viewerRows.innerHTML = rows;
    el.viewerCount.textContent = String(S.peers.length);
  }

  function updateViewerPositions() {
    var rows = el.viewerRows.rows;
    var base = masterTime();
    for (var i = 0; i < rows.length && i < S.peers.length; i++) {
      var p = S.peers[i];
      var pt = peerTime(p);
      rows[i].cells[1].textContent = tc(pt);
      rows[i].classList.toggle("is-drifting",
        p.id !== S.masterId && Math.abs(pt - base) > 1.5);
    }
  }

  function renderTakeover() {
    el.btnTakeover.hidden = !(surface.ready && !isMaster());
  }

  function renderQueue() {
    el.queueCount.textContent = String(S.queue.length + S.pending.length);
    el.queueEmpty.hidden = (S.queue.length + S.pending.length) > 0;

    var html = "";

    S.queue.forEach(function (item) {
      var isCur = S.current && item.id === S.current.id;
      html += '<li class="q-item' + (isCur ? " is-current" : "") + '" data-id="' + esc(item.id) + '">' +
        '<span class="q-thumb' + (item.poster ? "" : " is-loading") + '">' +
          (item.poster ? '<img src="' + esc(item.poster) + '" alt="" loading="lazy">' : "") +
          '<span class="q-dur">' + (item.duration ? tc(item.duration) : "--:--") + "</span>" +
        "</span>" +
        '<span class="q-body">' +
          '<span class="q-title">' + esc(item.title) + "</span>" +
          '<span class="q-by">' +
            (isCur ? '<span class="q-now">' + esc(t("queue.now")) + "</span> · " : "") +
            esc(byLine(item, "queue.by")) + "</span>" +
        "</span>" +
        '<button class="icon-btn icon-btn-xs q-del" data-del="' + esc(item.id) +
          '" title="' + esc(t("queue.remove")) + '">' + icon("i-trash") + "</button>" +
      "</li>";
    });

    /* Was gerade hochgeladen wird, steht schon in der Liste. */
    S.pending.forEach(function (up) {
      var mine = up.byId === S.me.id;
      var pct = Math.round(up.pct);
      html += '<li class="q-item is-coming" data-up="' + esc(up.id) + '">' +
        '<span class="q-thumb is-loading"></span>' +
        '<span class="q-body">' +
          '<span class="q-title">' + esc(up.title) + "</span>" +
          '<span class="q-by">' +
            '<span class="q-coming">' + esc(t("queue.coming")) + "</span> · " +
            esc(t("queue.by", { name: mine ? S.me.name : up.by })) + "</span>" +
          '<span class="q-bar"><i style="width:' + pct + '%"></i></span>' +
        "</span>" +
        (mine
          ? '<button class="icon-btn icon-btn-xs q-stop" data-stop="' + esc(up.id) +
            '" title="' + esc(t("queue.stop")) + '">' + icon("i-close") + "</button>"
          : '<span class="q-pct mono">' + pct + " %</span>") +
      "</li>";
    });

    el.queue.innerHTML = html;
  }

  /* Nur die Balken nachziehen, ohne die Liste neu zu bauen. */
  function paintPending() {
    S.pending.forEach(function (up) {
      var row = el.queue.querySelector('[data-up="' + up.id + '"]');
      if (!row) return;
      var fill = row.querySelector(".q-bar i");
      if (fill) fill.style.width = Math.round(up.pct) + "%";
      var pct = row.querySelector(".q-pct");
      if (pct) pct.textContent = Math.round(up.pct) + " %";
    });
  }

  function pendingById(id) {
    for (var i = 0; i < S.pending.length; i++) if (S.pending[i].id === id) return S.pending[i];
    return null;
  }

  function dropPending(id) {
    var before = S.pending.length;
    S.pending = S.pending.filter(function (u) { return u.id !== id; });
    if (S.pending.length !== before) renderQueue();
  }

  /* Frische Warteschlange vom Server. */
  function applyQueue(items) {
    noteGone(items);
    S.queue = items.slice();

    /* Laeuft gerade etwas, das es nicht mehr gibt? Dann weiter zum naechsten. */
    if (S.current && !itemById(S.current.id)) {
      loadItem(S.queue[0] || null);
      renderViewers();
      return;
    }
    if (!S.current) {
      applyNow(S.nowId);
      return;
    }
    /* Der laufende Eintrag kann frische Angaben tragen, etwa das Vorschaubild. */
    S.current = itemById(S.current.id) || S.current;
    renderQueue();
  }

  /* Nur oertlich entfernen. Der Server meldet die neue Liste ohnehin nach. */
  function dropLocal(id) {
    S.queue = S.queue.filter(function (item) { return item.id !== id; });
    renderQueue();
  }

  function removeFromQueue(id) {
    var item = itemById(id);
    if (!item) return;

    var wasCurrent = S.current && S.current.id === id;
    dropLocal(id);
    logAdd("log.del", item.title, logWho(S.me.id));

    if (wasCurrent) {
      takeControl(true);
      loadItem(S.queue[0] || null);
    }
    toast(t("toast.removed", { title: item.title }), "i-trash");

    api.remove(S.room, id).then(function () {
      send("changed", {});
    }, function () {
      toast(t("toast.failed"));
      refreshQueue();
    });
  }

  function refreshQueue() {
    api.queue(S.room).then(function (res) {
      applyQueue(res.queue || []);
    }, function () { /* beim naechsten Mal */ });
  }

  /* Texte, die im Code entstehen, nach einem Sprachwechsel neu setzen. */
  function refreshTexts() {
    doc.title = S.room ? t("doc.title", { room: S.room }) : "Watch Together";
    if (S.current) {
      el.nowTitle.textContent = S.current.title;
      el.nowBy.textContent = byLine(S.current, "now.by");
    } else {
      el.nowTitle.textContent = t("now.empty");
    }
    updatePlayUi();
    el.btnFull.setAttribute("title",
      t(doc.fullscreenElement === el.stage ? "ctl.exitFull" : "ctl.full"));
    applyWide(isWide());
    renderViewers();
    renderQueue();
    renderLog();
    if (!el.veilName.hidden) fillNameDialog(el.formName.dataset.mode === "change");
    if (S.jobs.length) { renderJobs(); paintUpload(); }
    /* Die Wortlisten haengen an der Sprache. */
    rollRooms();
    rollNames();
  }

  /* ------------------------------------------------------------- Zeitleiste */

  var dragging = false;

  function scrubToTime(clientX) {
    var r = el.scrub.getBoundingClientRect();
    var f = clamp((clientX - r.left) / r.width, 0, 1);
    return f * (surface.length || 0);
  }

  /* Die Zeit unter dem Zeiger. Damit laesst sich eine Stelle ansteuern, ohne
     erst hinzuspringen und dann nachzubessern. Die Blase bleibt innerhalb der
     Leiste, sonst haengt sie an schmalen Fenstern in der Luft. */
  function showHint(clientX) {
    var r = el.scrub.getBoundingClientRect();
    if (!surface.ready || !r.width) { hideHint(); return; }

    var f = clamp((clientX - r.left) / r.width, 0, 1);
    el.scrubHint.textContent = tc(f * (surface.length || 0));
    el.scrubHint.classList.add("is-on");

    var half = el.scrubHint.offsetWidth / 2;
    el.scrubHint.style.left = clamp(f * r.width, half, Math.max(half, r.width - half)) + "px";
  }

  function hideHint() { el.scrubHint.classList.remove("is-on"); }

  el.scrub.addEventListener("pointerdown", function (e) {
    if (!surface.ready) return;
    dragging = true;
    try { el.scrub.setPointerCapture(e.pointerId); } catch (err) { /* ohne Capture weiter */ }
    showHint(e.clientX);
    doSeek(scrubToTime(e.clientX));
  });
  el.scrub.addEventListener("pointermove", function (e) {
    showHint(e.clientX);
    if (!dragging) return;
    doSeek(scrubToTime(e.clientX));
  });
  el.scrub.addEventListener("pointerleave", function () {
    if (!dragging) hideHint();
  });
  el.scrub.addEventListener("pointerup", function (e) {
    dragging = false;
    hideHint();
    try {
      if (el.scrub.hasPointerCapture(e.pointerId)) el.scrub.releasePointerCapture(e.pointerId);
    } catch (err) { /* nichts zu loesen */ }
  });
  /* ------------------------------------------------------------- Bedienung */

  el.btnPlay.addEventListener("click", togglePlay);
  el.btnBack10.addEventListener("click", function () { skip(-SKIP); });
  el.btnFwd10.addEventListener("click", function () { skip(SKIP); });
  el.btnBigPlay.addEventListener("click", function (e) { e.stopPropagation(); doPlay(); });
  el.btnTakeover.addEventListener("click", function () { takeControl(false); });

  /* Das Bild selbst steuert nichts. Zu leicht rutscht sonst jemand aus, und
     der ganze Raum steht. Ein Klick sagt nur, wo die Bedienung liegt, ein
     Doppelklick schaltet auf Vollbild. Der erste Klick eines Doppelklicks
     wartet deshalb kurz ab. */
  var tapTimer = 0;

  el.stageTap.addEventListener("click", function () {
    if (tapTimer) return;
    tapTimer = global.setTimeout(function () {
      tapTimer = 0;
      toast(t("toast.noTap"), "i-play");
    }, 260);
  });

  el.stageTap.addEventListener("dblclick", function () {
    if (tapTimer) { global.clearTimeout(tapTimer); tapTimer = 0; }
    toggleFullscreen();
  });

  /* Ton bleibt bei jedem selbst, geht nie ueber die Leitung und wird im
     Browser gemerkt. */
  el.volRange.addEventListener("input", function () {
    var v = el.volRange.value / 100;
    surface.volume = v;
    store(STORE_VOL, String(Math.round(v * 100)));
    if (v > 0 && surface.muted) setMuted(false);
  });

  function setMuted(on) {
    surface.muted = on;
    el.btnMute.classList.toggle("is-muted", on);
    store(STORE_MUTE, on ? "1" : "0");
  }

  el.btnMute.addEventListener("click", function () { setMuted(!surface.muted); });

  function toggleFullscreen() {
    if (doc.fullscreenElement) doc.exitFullscreen();
    else if (el.stage.requestFullscreen) el.stage.requestFullscreen();
  }

  el.btnFull.addEventListener("click", toggleFullscreen);

  /* Grosses Bild. Zuschauer und Warteschlange raeumen dann die Spalte rechts
     und legen sich unter das Video, das Bild bekommt die Breite dazu. Die
     Wahl bleibt im Browser und geht niemanden sonst etwas an. */
  function isWide() { return el.app.classList.contains("is-wide"); }

  function applyWide(on) {
    el.app.classList.toggle("is-wide", on);
    el.btnWide.setAttribute("title", t(on ? "ctl.narrow" : "ctl.wide"));
  }

  el.btnWide.addEventListener("click", function () {
    var on = !isWide();
    applyWide(on);
    store(STORE_WIDE, on ? "1" : "0");
  });

  /* Im Vollbild bleibt die Steuerung dieselbe, sie zieht nur um: Titelzeile
     und Bedienleiste haengen sich an die Buehne und legen sich ueber das
     Bild. Damit gilt dort alles, was auch darunter gilt - vor allem, dass ein
     Klick auf das Bild nichts anhaelt.

     Nach fuenf Sekunden ohne Mausbewegung verschwinden beide wieder. Wer
     gerade an den Reglern steht, behaelt sie. */

  var FULL_IDLE_MS = 5000;
  var idleTimer = 0;
  var docked = null;         /* wohin die beiden Knoten zurueckgehoeren */

  function dock() {
    if (docked) return;
    docked = { parent: el.now.parentNode, after: el.now.nextSibling };
    el.stage.appendChild(el.now);
    el.stage.appendChild(el.controls);
  }

  function undock() {
    if (!docked) return;
    docked.parent.insertBefore(el.now, docked.after);
    docked.parent.insertBefore(el.controls, el.now);
    docked = null;
  }

  /* Der Zeiger hat sich geruehrt: alles wieder her und die Uhr neu stellen. */
  function wakeControls() {
    if (!el.stage.classList.contains("is-full")) return;
    el.stage.classList.remove("is-idle");
    if (idleTimer) global.clearTimeout(idleTimer);
    idleTimer = global.setTimeout(function () {
      idleTimer = 0;
      var busy = el.controls.matches(":hover") || el.now.matches(":hover") ||
                 el.controls.contains(doc.activeElement);
      if (busy) { wakeControls(); return; }
      el.stage.classList.add("is-idle");
      hideHint();
    }, FULL_IDLE_MS);
  }

  el.stage.addEventListener("pointermove", wakeControls);
  el.stage.addEventListener("pointerdown", wakeControls);

  doc.addEventListener("fullscreenchange", function () {
    var on = doc.fullscreenElement === el.stage;
    el.stage.classList.toggle("is-full", on);
    el.btnFull.setAttribute("title", t(on ? "ctl.exitFull" : "ctl.full"));

    if (on) { dock(); wakeControls(); return; }

    if (idleTimer) { global.clearTimeout(idleTimer); idleTimer = 0; }
    el.stage.classList.remove("is-idle");
    undock();
  });

  /* F11 gehoert hier dem Video, nicht dem Fenster. Solange ein Dialog offen
     ist oder gar kein Video anliegt, bleibt die Taste beim Browser. */
  doc.addEventListener("keydown", function (e) {
    if (e.key !== "F11" || e.altKey || e.ctrlKey || e.metaKey) return;
    if (el.app.hidden || veilOpen()) return;
    if (!doc.fullscreenElement && !surface.ready) return;
    e.preventDefault();
    toggleFullscreen();
  });

  el.queue.addEventListener("click", function (e) {
    var stop = e.target.closest("[data-stop]");
    if (stop) { cancelJob(stop.getAttribute("data-stop")); return; }
    var del = e.target.closest("[data-del]");
    if (del) { removeFromQueue(del.getAttribute("data-del")); return; }
    var row = e.target.closest(".q-item");
    if (!row || row.classList.contains("is-coming")) return;
    var id = row.getAttribute("data-id");
    if (S.current && S.current.id === id) return;
    var item = itemById(id);
    if (item) { takeControl(true); loadItem(item); }
  });

  /* ---------------------------------------------------------------- Raum */

  /* Vorschlaege aus dem Zufallsgenerator, drei Stueck je Dialog. */
  function pills(row, list) {
    row.innerHTML = list.map(function (v) {
      return '<button type="button" class="suggest-pill" data-pick="' + esc(v) + '">' +
        esc(v) + "</button>";
    }).join("");
  }

  function rollRooms() {
    pills(el.roomSuggestRow, names.room(3));
    el.inpRoom.placeholder = names.room();
  }

  function rollNames() {
    pills(el.nameSuggestRow, names.user(3));
    el.inpName.placeholder = names.user();
  }

  el.btnRoomMore.addEventListener("click", rollRooms);
  el.btnNameMore.addEventListener("click", rollNames);

  el.roomSuggestRow.addEventListener("click", function (e) {
    var b = e.target.closest("[data-pick]");
    if (!b) return;
    el.inpRoom.value = b.getAttribute("data-pick");
    el.errRoom.hidden = true;
    el.inpRoom.focus();
  });

  el.nameSuggestRow.addEventListener("click", function (e) {
    var b = e.target.closest("[data-pick]");
    if (!b) return;
    el.inpName.value = b.getAttribute("data-pick");
    el.errName.hidden = true;
    el.inpName.focus();
  });

  el.formRoom.addEventListener("submit", function (e) {
    e.preventDefault();
    var slug = slugify(el.inpRoom.value);
    if (!slug) {
      el.errRoom.textContent = t("room.err.empty");
      el.errRoom.hidden = false;
      return;
    }
    el.errRoom.hidden = true;
    enterRoom(slug, true);
  });

  function enterRoom(slug, push) {
    S.room = slug;
    el.roomName.textContent = slug;
    doc.title = t("doc.title", { room: slug });
    if (push) {
      global.history.pushState({ room: slug }, "",
        global.location.pathname + "?raum=" + encodeURIComponent(slug));
    }
    closeVeil(el.veilRoom);

    var saved = stored(STORE_NAME) || "";
    if (saved) { S.me.name = saved; openConnection(); }
    else askName(false);
  }

  el.btnCopyLink.addEventListener("click", function () {
    var url = global.location.href;
    if (global.navigator.clipboard && global.navigator.clipboard.writeText) {
      global.navigator.clipboard.writeText(url).then(
        function () { toast(t("toast.copied"), "i-check"); },
        function () { fallbackCopy(url); }
      );
    } else fallbackCopy(url);
  });

  function fallbackCopy(text) {
    var ta = doc.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:-1000px";
    doc.body.appendChild(ta);
    ta.select();
    try { doc.execCommand("copy"); toast(t("toast.copied"), "i-check"); }
    catch (e) { toast(text); }
    ta.remove();
  }

  global.addEventListener("popstate", function () {
    var slug = new URLSearchParams(global.location.search).get("raum");
    if (slug && slugify(slug) !== S.room) {
      /* Ein anderer Raum heisst: von vorn. */
      global.location.reload();
    }
  });

  global.addEventListener("beforeunload", function () {
    if (S.conn) S.conn.close();
  });

  /* ---------------------------------------------------------------- Name */

  function fillNameDialog(isChange) {
    el.nameTitle.textContent = t(isChange ? "name.title.change" : "name.title.first");
    el.nameLead.textContent  = t(isChange ? "name.lead.change" : "name.lead.first");
    el.btnNameSave.textContent = t(isChange ? "name.save.change" : "name.save.first");
    el.btnNameCancel.hidden = !isChange;
  }

  function askName(isChange) {
    el.formName.dataset.mode = isChange ? "change" : "first";
    fillNameDialog(isChange);
    el.inpName.value = S.me.name || "";
    el.errName.hidden = true;
    openVeil(el.veilName, el.inpName);
  }

  el.btnNameCancel.addEventListener("click", function () { closeVeil(el.veilName); });
  el.btnRename.addEventListener("click", function () { askName(true); });

  el.formName.addEventListener("submit", function (e) {
    e.preventDefault();
    var v = el.inpName.value.trim().replace(/\s+/g, " ");
    if (v.length < 2) {
      el.errName.textContent = t("name.err.short");
      el.errName.hidden = false;
      return;
    }
    var taken = S.peers.some(function (p) {
      return !p.isMe && p.name.toLowerCase() === v.toLowerCase();
    });
    if (taken) {
      el.errName.textContent = t("name.err.taken");
      el.errName.hidden = false;
      return;
    }
    el.errName.hidden = true;

    var wasChange = el.formName.dataset.mode === "change";
    S.me.name = v;
    store(STORE_NAME, v);
    closeVeil(el.veilName);

    if (wasChange) {
      send("name", { name: v });
      if (S.conn) S.conn.rename(v);
      applyMyName();
      toast(t("toast.renamed", { name: v }), "i-check");
    } else {
      openConnection();
    }
  });

  function applyMyName() {
    el.meName.textContent = S.me.name;
    el.meAvatar.textContent = initials(S.me.name);
    el.meAvatar.style.background = S.me.color;
    var me = peerById(S.me.id);
    if (me) me.name = S.me.name;
    S.queue.forEach(function (item) {
      if (item.addedById === S.me.id) item.addedBy = S.me.name;
    });
    renderViewers();
    renderQueue();
    if (S.current) el.nowBy.textContent = byLine(S.current, "now.by");
  }

  /* --------------------------------------------------- Raumeinstellungen */

  /* Sie gehoeren dem Raum, nicht dem Browser: sie liegen in seiner Datenbank,
     kommen mit dem "welcome" herein und gelten fuer alle gleich. Aendern darf
     sie jeder, wie auch jeder ein Video entfernen darf. */

  function cleanSettings(raw) {
    var v = raw || {};
    return {
      keep:    !!v.keep,
      opening: clamp(Number(v.opening) || 0, 0, 3600),
      ending:  clamp(Number(v.ending) || 0, 0, 3600)
    };
  }

  /* Eine Zeitangabe, wie sie jemand hinschreibt: "1:30", "90" oder gar
     nichts. Alles andere ist ein Vertipper und wird gemeldet. */
  function parseSpan(raw) {
    var v = String(raw).trim().replace(",", ".");
    if (v === "") return 0;

    var parts = v.split(":");
    if (parts.length > 2) return null;
    for (var i = 0; i < parts.length; i++) {
      if (!/^\d+(\.\d+)?$/.test(parts[i])) return null;
    }

    var secs = parts.length === 2
      ? parseInt(parts[0], 10) * 60 + parseFloat(parts[1])
      : parseFloat(parts[0]);

    if (parts.length === 2 && parseFloat(parts[1]) >= 60) return null;
    if (!isFinite(secs)) return null;
    return Math.min(3600, secs);
  }

  /* Nichts eingestellt bleibt ein leeres Feld, nicht "0:00". */
  function spanText(secs) { return secs > 0 ? tc(secs) : ""; }

  function openSettings() {
    el.setKeep.checked  = S.settings.keep;
    el.setOpening.value = spanText(S.settings.opening);
    el.setEnding.value  = spanText(S.settings.ending);
    el.errSettings.hidden = true;
    openVeil(el.veilSettings, el.setKeep);
  }

  function closeSettings() { closeVeil(el.veilSettings); }

  el.btnSettings.addEventListener("click", openSettings);
  el.btnSetClose.addEventListener("click", closeSettings);
  el.btnSetCancel.addEventListener("click", closeSettings);

  doc.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !el.veilSettings.hidden) closeSettings();
  });

  el.formSettings.addEventListener("submit", function (e) {
    e.preventDefault();

    var opening = parseSpan(el.setOpening.value);
    var ending  = parseSpan(el.setEnding.value);
    if (opening === null || ending === null) {
      el.errSettings.textContent = t("set.err.time");
      el.errSettings.hidden = false;
      return;
    }
    el.errSettings.hidden = true;

    var next = { keep: el.setKeep.checked, opening: opening, ending: ending };
    if (!send("settings", next)) { toast(t("toast.failed")); return; }

    /* Der Server bestaetigt gleich darauf mit dem endgueltigen Stand, samt
       Hinweis und Protokolleintrag. */
    closeSettings();
  });

  /* ------------------------------------------------------------- Sitzung */

  function openConnection() {
    el.linkLead.textContent = t("link.wait");
    openVeil(el.veilLink);
    /* Ab hier laeuft alles ueber Nachrichten. "welcome" bringt den Zustand. */
    S.conn = net.connect(S.room, S.me.name, onMessage, onLinkState);
  }

  function enterApp() {
    closeVeil(el.veilLink);
    el.badgeLink.hidden = true;
    /* Nach einem Neuaufbau habe ich eine neue Kennung im Raum. Was ich vorher
       gemeldet hatte, gilt dort nicht mehr. */
    toldReady = "";
    applyMyName();

    var first = !S.joined;
    S.joined = true;
    el.app.hidden = false;

    /* Das Protokoll beginnt hier. Was vorher war, geht mich nichts an. */
    playShown = S.remote.playing;
    renderLog();

    renderViewers();
    renderQueue();
    applyNow(S.nowId);
    surface.start();

    if (first) toast(t("toast.inRoom", { room: S.room }), "i-check");
  }

  /* ---------------------------------------------------------------- Upload */

  function activeJobs() {
    return S.jobs.filter(function (j) { return j.state === "waiting" || j.state === "running"; });
  }

  function openUpload() {
    el.mini.hidden = true;
    if (S.jobs.length) showRunning();
    else {
      el.upPick.hidden = false;
      el.upRun.hidden = true;
      el.upDone.hidden = true;
      el.btnUpMin.hidden = true;
      el.errFile.hidden = true;
      el.inpFile.value = "";
    }
    openVeil(el.veilUpload);
  }

  function showRunning() {
    el.upPick.hidden = true;
    el.upDone.hidden = true;
    el.upRun.hidden = false;
    el.btnUpMin.hidden = false;
    renderJobs();
    paintUpload();
  }

  el.btnAdd.addEventListener("click", openUpload);
  el.btnAddEmpty.addEventListener("click", openUpload);
  el.btnAddQueue.addEventListener("click", openUpload);
  el.btnUpClose.addEventListener("click", function () {
    if (activeJobs().length) minimizeUpload();
    else closeVeil(el.veilUpload);
  });

  el.drop.addEventListener("dragover", function (e) {
    e.preventDefault(); el.drop.classList.add("is-over");
  });
  el.drop.addEventListener("dragleave", function () { el.drop.classList.remove("is-over"); });
  el.drop.addEventListener("drop", function (e) {
    e.preventDefault();
    el.drop.classList.remove("is-over");
    if (e.dataTransfer.files) pickFiles(e.dataTransfer.files);
  });
  el.inpFile.addEventListener("change", function () {
    if (el.inpFile.files) pickFiles(el.inpFile.files);
  });

  /* Nur was der Browser ohne Umwandlung abspielt, darf hoch. */
  var probe = doc.createElement("video");
  var OTHER_VIDEO = /^(mkv|avi|wmv|flv|mpg|mpeg|ts|m2ts|mts|vob|3gp|divx|rm|rmvb|asf)$/;

  function playable(file) {
    var ext = (file.name.split(".").pop() || "").toLowerCase();
    var entry = null;
    for (var i = 0; i < PLAYABLE.length; i++) {
      if (PLAYABLE[i].ext === ext) { entry = PLAYABLE[i]; break; }
    }
    if (!entry) {
      var looksLikeVideo = /^video\//.test(file.type || "") || OTHER_VIDEO.test(ext);
      return looksLikeVideo ? "format" : "novideo";
    }
    var mime = file.type || entry.mime;
    return probe.canPlayType(mime) ? "ok" : "format";
  }

  var REASON = { novideo: "up.errVideo", format: "up.errType", size: "up.errSize" };

  function cleanTitle(fileName) {
    return fileName.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim() || fileName;
  }

  /* Mehrere Dateien auf einmal. Was nicht durchgeht, wird benannt und der
     Rest laeuft trotzdem. */
  function pickFiles(list) {
    var picked = [], skipped = [], firstReason = null;
    var max = api.settings().maxBytes || 0;   /* 0 heisst: keine Obergrenze */

    for (var i = 0; i < list.length; i++) {
      var file = list[i];
      var verdict = playable(file);
      if (verdict === "ok" && max > 0 && file.size > max) verdict = "size";
      if (verdict !== "ok") {
        skipped.push(file.name);
        if (!firstReason) firstReason = verdict;
        continue;
      }
      picked.push(file);
    }

    if (!picked.length) {
      el.errFile.textContent = skipped.length === 1
        ? t(REASON[firstReason])
        : t("up.skipped", { names: skipped.join(", ") });
      el.errFile.hidden = false;
      return;
    }

    el.errFile.hidden = true;
    if (skipped.length) toast(t("up.skipped", { names: skipped.join(", ") }));
    startBatch(picked);
  }

  /* ---------------------------------------------------------------- Ablauf */

  var batchDone = [];

  function startBatch(files) {
    files.forEach(function (file) {
      var entry = {
        id: "u" + (++S.seq) + "-" + Math.random().toString(36).slice(2, 6),
        name: file.name,
        size: file.size,
        file: file,
        title: cleanTitle(file.name),
        sent: 0,
        speed: 0,
        state: "waiting",
        sentPct: -1,
        mark: 0,
        markAt: 0,
        task: null
      };
      S.jobs.push(entry);

      /* Der Eintrag steht sofort in der Warteschlange, bei allen. */
      S.pending.push({
        id: entry.id, byId: S.me.id, by: S.me.name, title: entry.title, pct: 0
      });
      send("upload", { id: entry.id, title: entry.title, pct: 0 });
      entry.sentPct = 0;
    });

    renderQueue();
    el.miniName.textContent = miniLabel();
    showRunning();
    openVeil(el.veilUpload);
    pump();
  }

  function miniLabel() {
    var active = activeJobs();
    if (active.length > 1) return t("up.files", { n: active.length });
    return active.length ? active[0].name : "";
  }

  /* Eine Datei nach der anderen. */
  function pump() {
    var job = null;
    for (var i = 0; i < S.jobs.length; i++) {
      if (S.jobs[i].state === "waiting") { job = S.jobs[i]; break; }
      if (S.jobs[i].state === "running") return;   /* laeuft schon eine */
    }
    if (!job) { endBatch(); return; }

    job.state = "running";
    job.markAt = Date.now();
    job.mark = 0;
    renderJobs();

    job.task = api.upload({
      room: S.room,
      file: job.file,
      title: job.title,
      by: S.me.name,
      byId: S.me.id,
      onProgress: function (sent) {
        job.sent = sent;

        /* Tempo aus dem, was wirklich durchgeht. */
        var stamp = Date.now();
        var dt = (stamp - job.markAt) / 1000;
        if (dt >= 0.5) {
          var rate = (sent - job.mark) / dt;
          job.speed = job.speed ? job.speed * 0.7 + rate * 0.3 : rate;
          job.mark = sent;
          job.markAt = stamp;
        }

        var up = pendingById(job.id);
        if (up) up.pct = job.size ? (sent / job.size) * 100 : 100;

        paintUpload();
        paintJobs();
        paintPending();
      }
    });

    job.task.promise.then(function (item) {
      job.state = "done";
      job.sent = job.size;
      renderJobs();
      finishJob(job, item);
      pump();
    }, function (err) {
      if (err && err.reason === "aborted") { pump(); return; }
      failJob(job, err);
      pump();
    });
  }

  /* Laut Planung geht der Stand alle 2 Sekunden an die anderen. */
  function shareUploads() {
    S.jobs.forEach(function (job) {
      if (job.state !== "waiting" && job.state !== "running") return;
      var pct = Math.round(job.size ? (job.sent / job.size) * 100 : 0);
      if (pct === job.sentPct) return;          /* nichts Neues zu melden */
      job.sentPct = pct;
      send("upload", { id: job.id, title: job.title, pct: pct });
    });
  }

  function totals() {
    var size = 0, sent = 0, speed = 0;
    S.jobs.forEach(function (j) {
      size += j.size;
      sent += j.sent;
      if (j.state === "running") speed = j.speed;
    });
    return { size: size, sent: sent, speed: speed };
  }

  function paintUpload() {
    if (!S.jobs.length) return;
    var sum = totals();
    var pct = sum.size ? (sum.sent / sum.size) * 100 : 0;
    var pctText = t("up.pct", { n: pct.toFixed(0) });

    el.upBar.style.width = pct + "%";
    el.upPct.textContent = pctText;
    el.miniBar.style.width = pct + "%";
    el.miniPct.textContent = pctText;

    if (sum.speed > 0) {
      var left = Math.max(0, (sum.size - sum.sent) / sum.speed);
      el.upSpeed.textContent = t("up.speed", { n: num(sum.speed / 1048576, 1) });
      el.upEta.textContent = t("up.eta", { time: tc(left) });
      el.miniEta.textContent = tc(left);
    } else {
      el.upSpeed.textContent = "";
      el.upEta.textContent = "";
      el.miniEta.textContent = "";
    }
  }

  function jobState(job) {
    if (job.state === "done") return icon("i-check");
    if (job.state === "waiting") return esc(t("up.waiting"));
    return Math.round(job.size ? (job.sent / job.size) * 100 : 0) + " %";
  }

  function renderJobs() {
    el.upList.innerHTML = S.jobs.map(function (j) {
      var pct = j.size ? (j.sent / j.size) * 100 : 0;
      return '<li class="up-row" data-job="' + j.id + '">' +
        '<span class="up-row-name">' + esc(j.name) + "</span>" +
        '<span class="up-row-size mono">' + bytes(j.size) + "</span>" +
        '<span class="up-row-state mono' + (j.state === "done" ? " is-done" : "") + '">' +
          jobState(j) + "</span>" +
        (j.state === "done" ? '<span class="up-row-gap"></span>'
          : '<button class="icon-btn icon-btn-xs up-row-x" data-cancel="' + j.id +
            '" title="' + esc(t("up.dropOne")) + '">' + icon("i-close") + "</button>") +
        '<span class="up-row-bar"><i style="width:' + pct + '%"></i></span>' +
      "</li>";
    }).join("");
  }

  function paintJobs() {
    S.jobs.forEach(function (j) {
      var row = el.upList.querySelector('[data-job="' + j.id + '"]');
      if (!row) return;
      var pct = j.size ? (j.sent / j.size) * 100 : 0;
      row.querySelector(".up-row-bar i").style.width = pct + "%";
      var st = row.querySelector(".up-row-state");
      if (j.state !== "done") st.textContent = jobState(j);
    });
  }

  el.upList.addEventListener("click", function (e) {
    var b = e.target.closest("[data-cancel]");
    if (b) cancelJob(b.getAttribute("data-cancel"));
  });

  function forget(id) {
    var job = null;
    S.jobs = S.jobs.filter(function (j) {
      if (j.id !== id) return true;
      job = j;
      return false;
    });
    return job;
  }

  function cancelJob(id) {
    var job = forget(id);
    if (!job) return;

    if (job.task) job.task.cancel();
    dropPending(id);
    send("upload-end", { id: id, ok: false });
    toast(t("toast.aborted", { name: job.name }));

    renderJobs();
    paintUpload();
    el.miniName.textContent = miniLabel();
    if (job.state === "running") pump();
    else if (!activeJobs().length) endBatch();
  }

  function failJob(job, err) {
    forget(job.id);
    dropPending(job.id);
    send("upload-end", { id: job.id, ok: false });
    /* Der Server hat die Datei als unbrauchbar erkannt und schon geloescht.
       Der Eintrag ist damit ueberall aus der Warteschlange raus. */
    toast(err && err.reason === "invalid"
      ? t("toast.badVideo", { name: job.name })
      : ((err && err.message) || t("toast.failed")));
    renderJobs();
    el.miniName.textContent = miniLabel();
  }

  /* Fertig. Laufzeit und Vorschaubild hat der Server erzeugt, der Eintrag
     steht in der Datenbank des Raumes. Die anderen erfahren nur, dass die
     Uebertragung durch ist, und holen sich die frische Liste. */
  function finishJob(job, item) {
    dropPending(job.id);
    send("upload-end", { id: job.id, ok: true });

    if (item && !itemById(item.id)) S.queue.push(item);
    batchDone.push(item ? item.title : job.title);
    logAdd("log.add", item ? item.title : job.title, logWho(S.me.id));
    renderQueue();

    if (!S.current && item) loadItem(item);
    toast(t("toast.added", { title: item ? item.title : job.title }), "i-check");
  }

  /* Alles durch: Fenster aufraeumen, Balken unten rechts verschwindet. */
  function endBatch() {
    if (activeJobs().length) return;
    S.jobs = [];
    hideMini();

    if (!batchDone.length) {
      /* Nur Abbrueche: zurueck zur Auswahl. */
      el.upRun.hidden = true;
      el.upDone.hidden = true;
      el.upPick.hidden = false;
      el.btnUpMin.hidden = true;
      el.inpFile.value = "";
      return;
    }

    el.doneText.textContent = batchDone.length === 1
      ? t("up.ready", { title: batchDone[0] })
      : t("up.readyN", { n: batchDone.length });
    batchDone = [];
    el.upRun.hidden = true;
    el.upPick.hidden = true;
    el.upDone.hidden = false;
    el.btnUpMin.hidden = true;
  }

  function minimizeUpload() {
    if (!activeJobs().length) return;
    closeVeil(el.veilUpload);
    el.miniName.textContent = miniLabel();
    el.mini.hidden = false;
    el.mini.classList.remove("is-leaving");
  }

  el.btnUpMin.addEventListener("click", minimizeUpload);
  el.btnUpMin2.addEventListener("click", minimizeUpload);
  el.btnMiniOpen.addEventListener("click", openUpload);
  el.btnUpAbort.addEventListener("click", function () {
    activeJobs().forEach(function (j) { cancelJob(j.id); });
  });

  function hideMini() {
    if (el.mini.hidden) return;
    el.mini.classList.add("is-leaving");
    global.setTimeout(function () {
      el.mini.hidden = true;
      el.mini.classList.remove("is-leaving");
    }, 300);
  }

  el.btnUpFinish.addEventListener("click", function () { closeVeil(el.veilUpload); });

  /* ---------------------------------------------------------------- Thema */
  /* Standard ist die Einstellung des Systems. Schaltet jemand um, gilt die
     eigene Wahl dauerhaft. */

  var darkQuery = global.matchMedia ? global.matchMedia("(prefers-color-scheme: dark)") : null;

  function currentTheme() {
    var own = stored(STORE_THEME);
    if (own === "dark" || own === "light") return own;
    return darkQuery && darkQuery.matches ? "dark" : "light";
  }

  function applyTheme() {
    doc.documentElement.setAttribute("data-theme", currentTheme());
  }

  if (darkQuery && darkQuery.addEventListener) {
    darkQuery.addEventListener("change", function () {
      if (!stored(STORE_THEME)) applyTheme();
    });
  }

  el.btnTheme.addEventListener("click", function () {
    store(STORE_THEME, currentTheme() === "dark" ? "light" : "dark");
    applyTheme();
  });

  /* ----------------------------------------------------------------- Lauf */

  surface.onTick = function () {
    if (!surface.ready) return;
    updateScrub();
    updatePlayUi();
  };

  /* Abgleich und Anzeige laufen ruhiger als das Bild. */
  global.setInterval(function () {
    if (el.app.hidden) return;
    /* Erst an die richtige Stelle, dann losspielen lassen. */
    startTick();
    tellReady();
    startWhenAllReady();
    updateWait();
    syncTick();
    endingTick();
    updateViewerPositions();
    renderPeerTicks();
  }, 250);

  /* Eigene Position melden. */
  global.setInterval(sendPos, net.POS_MS);

  /* Als Taktgeber den Zustand im festen Takt melden. */
  global.setInterval(sendVideo, net.MASTER_MS);

  /* Laufende Uploads im festen Takt melden. */
  global.setInterval(shareUploads, net.UPLOAD_MS);

  /* --------------------------------------------------------------- Start */

  i18n.onChange(refreshTexts);

  function boot() {
    i18n.set(i18n.detect());
    applyTheme();

    /* Ton: gemerkte Einstellung, sonst die Haelfte. */
    var vol = parseInt(stored(STORE_VOL), 10);
    if (!(vol >= 0 && vol <= 100)) vol = 50;
    el.volRange.value = vol;
    surface.volume = vol / 100;
    surface.muted = stored(STORE_MUTE) === "1";
    el.btnMute.classList.toggle("is-muted", surface.muted);

    applyWide(stored(STORE_WIDE) === "1");

    rollRooms();
    rollNames();

    /* Erst die Angaben des Servers holen, dann geht es los. */
    api.boot().then(start, function () {
      el.linkLead.textContent = t("link.retry");
      openVeil(el.veilLink);
      global.setTimeout(function () { api.boot().then(start, function () {}); }, 4000);
    });
  }

  function start() {
    closeVeil(el.veilLink);
    var slug = new URLSearchParams(global.location.search).get("raum");
    if (slug && slugify(slug)) enterRoom(slugify(slug), false);
    else openVeil(el.veilRoom, el.inpRoom);
  }

  boot();

})(window);
