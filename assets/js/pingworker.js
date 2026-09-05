/* ============================================================================
   tk.weslie.WatchTogether.pingworker

   Herzschlag fuer die Live-Verbindung, aus einem eigenen Worker heraus.
   Browser drosseln setInterval im Hauptthread eines verdeckten Tabs nach
   einer Weile auf nur noch einmal pro Minute - das reisst das knappe
   Zeitfenster, das der Server fuer ein Lebenszeichen einraeumt (siehe
   Hub::TIMEOUT). Ein dedizierter Worker unterliegt dieser Drosselung nicht,
   darum sitzt hier nur der Taktgeber; gesendet wird weiterhin im Haupt-
   thread, der allein die offene WebSocket-Verbindung haelt.
   ========================================================================= */
var timer = null;

self.onmessage = function (e) {
  var msg = (e && e.data) || {};
  if (msg.type === "start") {
    if (timer) clearInterval(timer);
    var ms = msg.ms > 0 ? msg.ms : 2000;
    timer = setInterval(function () {
      self.postMessage({ type: "tick" });
    }, ms);
  } else if (msg.type === "stop") {
    if (timer) clearInterval(timer);
    timer = null;
  }
};
