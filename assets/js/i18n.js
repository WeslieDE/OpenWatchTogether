/* ============================================================================
   tk.weslie.WatchTogether.i18n

   Zwei Sprachen, Deutsch und Englisch. Es gilt die Sprache des Browsers,
   alles andere landet bei Englisch.

   Markup: data-i18n="schluessel" setzt den Textinhalt,
           data-i18n-attr="placeholder:schluessel,title:schluessel" setzt Attribute.
   Code:   t("schluessel", { name: "Liv" })
   ========================================================================= */
(function (global) {
  "use strict";

  var tk = global.tk = global.tk || {};
  var w  = tk.weslie = tk.weslie || {};
  var WT = w.WatchTogether = w.WatchTogether || {};

  var DICT = {

    de: {
      "doc.title":        "{room} · Watch Together",

      "room.lead":        "Gib einen Raumnamen ein.",
      "room.label":       "Raum",
      "room.hint":        "Buchstaben, Zahlen und Bindestriche.",
      "room.submit":      "Weiter",
      "room.err.empty":   "Bitte einen Namen eingeben.",
      "room.github":      "Watch Together auf GitHub",

      "suggest.label":    "Vorschläge",
      "suggest.more":     "Andere Vorschläge",

      "name.title.first":  "Wie heißt du?",
      "name.title.change": "Name ändern",
      "name.lead.first":   "Die anderen im Raum sehen diesen Namen.",
      "name.lead.change":  "Die anderen sehen die Änderung sofort.",
      "name.label":        "Name",
      "name.save.first":   "Los geht's",
      "name.save.change":  "Speichern",
      "name.cancel":       "Abbrechen",
      "name.err.short":    "Mindestens zwei Zeichen.",
      "name.err.taken":    "Der Name ist im Raum schon vergeben.",

      "top.add":      "Video hinzufügen",
      "top.live":     "Livestream starten",
      "top.liveStop": "Livestream beenden",
      "top.theme":    "Ansicht wechseln",
      "top.rename":   "Namen ändern",
      "top.copy":     "Link kopieren",
      "top.settings": "Raumeinstellungen",

      "set.title":         "Raumeinstellungen",
      "set.lead":          "Sie gelten für alle im Raum und bleiben, bis jemand sie wieder ändert.",
      "set.keep.label":    "Videos behalten",
      "set.keep.hint":     "Ein durchgelaufenes Video bleibt in der Warteschlange, statt gelöscht zu werden. Solange noch Videos im Raum liegen, bleibt auch der Raum bestehen – über einen Neustart hinweg.",
      "set.go.label":      "Bereit-Modus",
      "set.go.hint":       "Wechselt das Video, wartet der Raum, bis alle auf „Bereit“ gedrückt haben. Während der Wiedergabe hat das Zeichen keine Wirkung – wer es zurückzieht, hält erst das nächste Video auf.",
      "set.marks.title":   "Vorspann und Abspann",
      "set.marks.lead":    "Beim Wechsel auf ein anderes Video startet es hinter dem Vorspann und gilt als durch, sobald der Abspann anfängt. Leere Felder heißen: ganz von vorn bis ganz zum Schluss.",
      "set.opening.label": "Ende des Vorspanns",
      "set.opening.hint":  "Vom Anfang der Datei gemessen.",
      "set.ending.label":  "Anfang des Abspanns",
      "set.ending.hint":   "Vom Ende der Datei gemessen.",
      "set.err.time":      "Bitte eine Zeit wie 1:30 eingeben.",
      "set.save":          "Speichern",
      "set.cancel":        "Abbrechen",

      "stage.empty.title": "Noch nichts zu sehen",
      "stage.empty.sub":   "Leg ein Video dazu, dann geht es für alle gleichzeitig los.",
      "stage.sync":        "Wird angeglichen",
      "stage.wait":        "Warte auf alle · {n}/{total} bereit",
      "stage.go.on":       "Bereit",
      "stage.go.off":      "Bereit?",
      "stage.live":        "Live",

      "ctl.play":   "Abspielen",
      "ctl.pause":  "Pause",
      "ctl.back10": "10 Sekunden zurück",
      "ctl.fwd10":  "10 Sekunden vor",
      "ctl.mute":   "Ton aus",
      "ctl.volume": "Lautstärke",
      "ctl.wide":     "Video vergrößern",
      "ctl.narrow":   "Video verkleinern",
      "ctl.full":     "Vollbild (F11)",
      "ctl.exitFull": "Vollbild verlassen (F11)",

      "now.empty":    "Nichts ausgewählt",
      "now.by":       "hinzugefügt von {name}",
      "now.takeover": "Steuerung übernehmen",
      "now.go.on":    "Bereit",
      "now.go.off":   "Nicht bereit",

      "quality.label":    "Bildqualität",
      "quality.motion":   "Bewegung",
      "quality.balanced": "Ausgewogen",
      "quality.text":     "Text",

      "viewers.title":     "Zuschauer",
      "viewers.name":      "Name",
      "viewers.pos":       "Position",
      "viewers.connected": "Verbunden",
      "viewers.you":       "du",
      "viewers.master":    "gibt den Takt vor",

      "queue.title":  "Warteschlange",
      "queue.now":    "läuft",
      "queue.by":     "von {name}",
      "queue.remove": "Entfernen",
      "queue.empty":  "Die Warteschlange ist leer.",
      "queue.coming": "wird geladen",
      "queue.stop":   "Übertragung abbrechen",

      "log.title":  "Protokoll",
      "log.time":   "Uhrzeit",
      "log.what":   "Aktion",
      "log.who":    "Teilnehmer",
      "log.empty":  "Seit deinem Beitritt ist nichts passiert.",
      "log.play":   "Video gestartet",
      "log.pause":  "Video angehalten",
      "log.add":    "Video hinzugefügt: „{title}“",
      "log.del":    "Video entfernt: „{title}“",
      "log.switch": "Video gewechselt: „{title}“",
      "log.settings": "Raumeinstellungen geändert",
      "log.liveStart": "Bildschirmübertragung gestartet",
      "log.liveStop":  "Bildschirmübertragung beendet",

      "up.title":     "Video hinzufügen",
      "up.drop":      "Dateien hierher ziehen",
      "up.dropSub":   "oder klicken zum Auswählen. MP4, WebM oder OGG, jede Größe.",
      "up.waiting":   "wartet",
      "up.files":     "{n} Dateien",
      "up.skipped":   "Übersprungen: {names}",
      "up.dropOne":   "Diese Datei abbrechen",
      "up.min":       "In die Ecke legen",
      "up.close":     "Schließen",
      "up.open":      "Öffnen",
      "up.abort":     "Abbrechen",
      "up.keep":      "Weiterschauen",
      "up.finish":    "Fertig",
      "up.eta":       "noch {time}",
      "up.speed":     "{n} MB/s",
      "up.pct":       "{n} %",
      "up.errVideo":  "Das sieht nicht nach einem Video aus.",
      "up.errType":   "Dieses Format kann der Browser nicht direkt abspielen. Nimm MP4, WebM oder OGG.",
      "up.errSize":   "Die Datei ist zu groß.",
      "up.errMobile": "MKV/AVI lassen sich auf dem Handy nicht umwandeln. Bitte am Rechner hochladen oder vorher zu MP4 machen.",
      "up.converting": "wandelt um {n} %",
      "up.ready":     "„{title}“ ist in der Warteschlange.",
      "up.readyN":    "{n} Videos sind in der Warteschlange.",

      "toast.copied":        "Link kopiert",
      "toast.synced":        "Deine Video Position wurde an die der anderen Teilnemer angeglichen.",
      "toast.inRoom":        "Du bist im Raum {room}",
      "toast.youControl":    "Du gibst jetzt den Takt vor",
      "toast.renamed":       "Du heißt jetzt {name}",
      "toast.added":         "„{title}“ hinzugefügt",
      "toast.removed":       "„{title}“ entfernt",
      "toast.finished":      "„{title}“ ist durch",
      "toast.next":          "Als Nächstes: {title}",
      "toast.aborted":       "Übertragung abgebrochen: {name}",
      "toast.peerJoined":    "{name} ist dazugekommen",
      "toast.peerLeft":      "{name} ist weg",
      "toast.peerControl":   "{name} hat die Steuerung übernommen",
      "toast.needControl":   "Dafür musst du erst die Steuerung übernehmen.",
      "toast.youGo":         "Du bist bereit",
      "toast.youNoGo":       "Du bist nicht mehr bereit",
      "toast.peerGo":        "{name} ist bereit",
      "toast.peerNoGo":      "{name} ist nicht mehr bereit",
      "toast.blocked":       "Einmal tippen, dann läuft es mit.",
      "toast.noTap":         "Play und Pause laufen über die Leiste unter dem Video. Doppelklick schaltet auf Vollbild.",
      "toast.settingsSaved": "Raumeinstellungen gespeichert",
      "toast.settings":      "{name} hat die Raumeinstellungen geändert",
      "toast.badVideo":      "„{name}“ ist kein abspielbares Video und wurde wieder entfernt.",
      "toast.failed":        "Das hat nicht geklappt.",
      "toast.liveStarted":   "{name} überträgt jetzt den Bildschirm",
      "toast.liveStopped":   "Die Bildschirmübertragung ist vorbei",
      "toast.liveDenied":    "Nur der Taktgeber kann einen Livestream starten.",
      "toast.liveFailed":    "Die Bildschirmfreigabe wurde nicht erteilt.",

      "link.title":     "Gleich geht es los",
      "link.wait":      "Der Raum wird geöffnet.",
      "link.retry":     "Der Raum ist gerade nicht erreichbar. Es wird weiter versucht.",
      "link.lost":      "Verbindung unterbrochen",
      "toast.linkLost": "Die Verbindung ist weg. Es wird weiter versucht.",
      "toast.linkBack": "Wieder verbunden"
    },

    en: {
      "doc.title":        "{room} · Watch Together",

      "room.lead":        "Enter a room name.",
      "room.label":       "Room",
      "room.hint":        "Letters, numbers and hyphens.",
      "room.submit":      "Continue",
      "room.err.empty":   "Please enter a name.",
      "room.github":      "Watch Together on GitHub",

      "suggest.label":    "Suggestions",
      "suggest.more":     "Other suggestions",

      "name.title.first":  "What's your name?",
      "name.title.change": "Change name",
      "name.lead.first":   "Everyone in the room sees this name.",
      "name.lead.change":  "Everyone sees the change right away.",
      "name.label":        "Name",
      "name.save.first":   "Let's go",
      "name.save.change":  "Save",
      "name.cancel":       "Cancel",
      "name.err.short":    "At least two characters.",
      "name.err.taken":    "That name is already taken in this room.",

      "top.add":      "Add video",
      "top.live":     "Start livestream",
      "top.liveStop": "Stop livestream",
      "top.theme":    "Switch appearance",
      "top.rename":   "Change name",
      "top.copy":     "Copy link",
      "top.settings": "Room settings",

      "set.title":         "Room settings",
      "set.lead":          "They apply to everyone in the room and stay until someone changes them.",
      "set.keep.label":    "Keep videos",
      "set.keep.hint":     "A video that has run through stays in the queue instead of being deleted. As long as videos are left in the room, the room stays too – across a restart.",
      "set.go.label":      "Ready check",
      "set.go.hint":       "When the video changes, the room waits until everyone has hit “Ready”. During playback the mark has no effect – taking it back only holds up the next video.",
      "set.marks.title":   "Opening and ending",
      "set.marks.lead":    "When switching to another video it starts behind the opening and counts as finished once the ending begins. Empty fields mean: all the way from the start to the very end.",
      "set.opening.label": "End of the opening",
      "set.opening.hint":  "Measured from the start of the file.",
      "set.ending.label":  "Start of the ending",
      "set.ending.hint":   "Measured from the end of the file.",
      "set.err.time":      "Please enter a time like 1:30.",
      "set.save":          "Save",
      "set.cancel":        "Cancel",

      "stage.empty.title": "Nothing here yet",
      "stage.empty.sub":   "Add a video and it starts for everyone at the same time.",
      "stage.sync":        "Catching up",
      "stage.wait":        "Waiting for everyone · {n}/{total} ready",
      "stage.go.on":       "Ready",
      "stage.go.off":      "Ready?",
      "stage.live":        "Live",

      "ctl.play":   "Play",
      "ctl.pause":  "Pause",
      "ctl.back10": "Back 10 seconds",
      "ctl.fwd10":  "Forward 10 seconds",
      "ctl.mute":   "Mute",
      "ctl.volume": "Volume",
      "ctl.wide":     "Enlarge video",
      "ctl.narrow":   "Shrink video",
      "ctl.full":     "Full screen (F11)",
      "ctl.exitFull": "Leave full screen (F11)",

      "now.empty":    "Nothing selected",
      "now.by":       "added by {name}",
      "now.takeover": "Take control",
      "now.go.on":    "Ready",
      "now.go.off":   "Not ready",

      "quality.label":    "Video quality",
      "quality.motion":   "Motion",
      "quality.balanced": "Balanced",
      "quality.text":     "Text",

      "viewers.title":     "Viewers",
      "viewers.name":      "Name",
      "viewers.pos":       "Position",
      "viewers.connected": "Connected",
      "viewers.you":       "you",
      "viewers.master":    "sets the pace",

      "queue.title":  "Up next",
      "queue.now":    "playing",
      "queue.by":     "by {name}",
      "queue.remove": "Remove",
      "queue.empty":  "Nothing queued.",
      "queue.coming": "uploading",
      "queue.stop":   "Stop the upload",

      "log.title":  "Activity",
      "log.time":   "Time",
      "log.what":   "Action",
      "log.who":    "Participant",
      "log.empty":  "Nothing has happened since you joined.",
      "log.play":   "Video started",
      "log.pause":  "Video paused",
      "log.add":    "Video added: “{title}”",
      "log.del":    "Video removed: “{title}”",
      "log.switch": "Switched video: “{title}”",
      "log.settings": "Room settings changed",
      "log.liveStart": "Screen sharing started",
      "log.liveStop":  "Screen sharing stopped",

      "up.title":     "Add video",
      "up.drop":      "Drag files here",
      "up.dropSub":   "or click to choose. MP4, WebM or OGG, any size.",
      "up.waiting":   "waiting",
      "up.files":     "{n} files",
      "up.skipped":   "Skipped: {names}",
      "up.dropOne":   "Cancel this file",
      "up.min":       "Move to the corner",
      "up.close":     "Close",
      "up.open":      "Open",
      "up.abort":     "Cancel",
      "up.keep":      "Keep watching",
      "up.finish":    "Done",
      "up.eta":       "{time} left",
      "up.speed":     "{n} MB/s",
      "up.pct":       "{n}%",
      "up.errVideo":  "That does not look like a video.",
      "up.errType":   "Your browser cannot play this format directly. Use MP4, WebM or OGG.",
      "up.errSize":   "The file is too large.",
      "up.errMobile": "MKV/AVI can't be converted on mobile. Upload from a desktop, or convert to MP4 first.",
      "up.converting": "converting {n}%",
      "up.ready":     "“{title}” is queued.",
      "up.readyN":    "{n} videos are queued.",

      "toast.copied":        "Link copied",
      "toast.synced":        "Your video position was aligned with the other participants.",
      "toast.inRoom":        "You are in {room}",
      "toast.youControl":    "You set the pace now",
      "toast.renamed":       "Your name is now {name}",
      "toast.added":         "“{title}” added",
      "toast.removed":       "“{title}” removed",
      "toast.finished":      "“{title}” finished",
      "toast.next":          "Up next: {title}",
      "toast.aborted":       "Upload cancelled: {name}",
      "toast.peerJoined":    "{name} joined",
      "toast.peerLeft":      "{name} left",
      "toast.peerControl":   "{name} took control",
      "toast.needControl":   "Take control first to do that.",
      "toast.youGo":         "You are ready",
      "toast.youNoGo":       "You are no longer ready",
      "toast.peerGo":        "{name} is ready",
      "toast.peerNoGo":      "{name} is no longer ready",
      "toast.blocked":       "Tap once and it plays along.",
      "toast.noTap":         "Play and pause live in the bar below the video. Double-click switches to full screen.",
      "toast.settingsSaved": "Room settings saved",
      "toast.settings":      "{name} changed the room settings",
      "toast.badVideo":      "“{name}” is not a playable video and was removed again.",
      "toast.failed":        "That did not work.",
      "toast.liveStarted":   "{name} is now sharing their screen",
      "toast.liveStopped":   "The livestream has ended",
      "toast.liveDenied":    "Only the pace-setter can start a livestream.",
      "toast.liveFailed":    "Screen sharing was not allowed.",

      "link.title":     "Almost there",
      "link.wait":      "Opening the room.",
      "link.retry":     "The room cannot be reached right now. Still trying.",
      "link.lost":      "Connection lost",
      "toast.linkLost": "The connection dropped. Still trying.",
      "toast.linkBack": "Back online"
    }
  };

  var lang = "en";
  var listeners = [];

  /* Browsersprache lesen. Alles ausser Deutsch faellt auf Englisch zurueck. */
  function detect() {
    var list = global.navigator.languages && global.navigator.languages.length
      ? global.navigator.languages
      : [global.navigator.language || "en"];
    for (var i = 0; i < list.length; i++) {
      var code = String(list[i] || "").toLowerCase().split("-")[0];
      if (DICT[code]) return code;
    }
    return "en";
  }

  function t(key, vars) {
    var s = (DICT[lang] && DICT[lang][key]);
    if (s == null) s = DICT.en[key];
    if (s == null) return key;
    if (!vars) return s;
    return s.replace(/\{(\w+)\}/g, function (m, k) {
      return vars[k] == null ? m : vars[k];
    });
  }

  /* Alle beschrifteten Knoten unterhalb von root neu setzen. */
  function apply(root) {
    var scope = root || global.document;

    scope.querySelectorAll("[data-i18n]").forEach(function (node) {
      node.textContent = t(node.getAttribute("data-i18n"));
    });

    scope.querySelectorAll("[data-i18n-attr]").forEach(function (node) {
      node.getAttribute("data-i18n-attr").split(",").forEach(function (pair) {
        var bits = pair.split(":");
        if (bits.length === 2) node.setAttribute(bits[0].trim(), t(bits[1].trim()));
      });
    });
  }

  function set(code) {
    lang = DICT[code] ? code : "en";
    global.document.documentElement.setAttribute("lang", lang);
    apply();
    listeners.forEach(function (fn) { fn(lang); });
  }

  WT.i18n = {
    t: t,
    apply: apply,
    set: set,
    get: function () { return lang; },
    other: function () { return lang === "de" ? "en" : "de"; },
    detect: detect,
    onChange: function (fn) { listeners.push(fn); }
  };

})(window);
