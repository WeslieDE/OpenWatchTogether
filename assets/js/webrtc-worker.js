/* ============================================================================
   tk.weslie.WatchTogether.webrtc-worker

   Taktgeber fuer webrtc.js, aus einem eigenen Worker heraus - aus demselben
   Grund wie pingworker.js beim Haupt-Websocket: Browser drosseln
   setTimeout/setInterval im Hauptthread eines verdeckten Tabs nach einer
   Weile auf nur noch einmal pro Minute. Ein Worker unterliegt dieser
   Drosselung nicht.

   Anders als pingworker.js braucht webrtc.js mehrere gleichzeitig laufende,
   unabhaengig voneinander loeschbare Zeitgeber (der Keepalive-Ping je
   Signalisierungskanal, der wachsende Reconnect-Abstand je Sitzung) - darum
   hier eine Kennung je Timer statt eines einzelnen globalen Intervalls.
   ========================================================================= */
var timers = {}; /* id => Handle von setTimeout/setInterval */

/* clearTimeout/clearInterval teilen sich in jeder Umgebung denselben
   Zaehlraum - welche der beiden hier passend waere, muss darum nicht
   mitgefuehrt werden. */
function clear(id) {
  if (!(id in timers)) return;
  clearTimeout(timers[id]);
  clearInterval(timers[id]);
  delete timers[id];
}

self.onmessage = function (e) {
  var msg = (e && e.data) || {};
  var id = msg.id;
  if (!id) return;

  if (msg.type === "timeout") {
    clear(id);
    timers[id] = setTimeout(function () {
      delete timers[id];
      self.postMessage({ id: id });
    }, msg.ms > 0 ? msg.ms : 0);
  } else if (msg.type === "interval") {
    clear(id);
    timers[id] = setInterval(function () {
      self.postMessage({ id: id });
    }, msg.ms > 0 ? msg.ms : 1000);
  } else if (msg.type === "clear") {
    clear(id);
  }
};
