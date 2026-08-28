/* Uebernimmt die im Hauptprogramm gewaehlte Erscheinung (assets/js/app.js,
   Speicherschluessel "wt.theme"), damit die Rechtstexte nicht aus dem Rahmen
   fallen. Ohne eigene Wahl gilt die Systemeinstellung. */
(function () {
  "use strict";
  var stored = null;
  try { stored = localStorage.getItem("wt.theme"); } catch (e) { /* ohne Speicher weiter */ }
  if (stored === "dark" || stored === "dim" || stored === "light") {
    document.documentElement.setAttribute("data-theme", stored);
  }
})();
