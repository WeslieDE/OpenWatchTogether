/* ============================================================================
   tk.weslie.WatchTogether.names

   Zufallsnamen als Vorschlag: Fruechte fuer Teilnehmer, Alltagsgegenstaende
   fuer Raeume, jeweils mit zwei Ziffern am Ende. Die Wortlisten folgen der
   eingestellten Sprache.
   ========================================================================= */
(function (global) {
  "use strict";

  var WT = global.tk.weslie.WatchTogether;
  var i18n = WT.i18n;

  var WORDS = {
    de: {
      user: [
        "Erdbeere", "Banane", "Apfel", "Birne", "Kirsche", "Pflaume", "Mango",
        "Ananas", "Melone", "Traube", "Pfirsich", "Zitrone", "Orange", "Feige",
        "Kiwi", "Aprikose", "Himbeere", "Brombeere", "Dattel", "Papaya",
        "Mandarine", "Nektarine", "Quitte", "Stachelbeere", "Holunder", "Mirabelle"
      ],
      /* Bewusst ohne Umlaute, damit der Raumlink lesbar bleibt. */
      room: [
        "Kugelschreiber", "Uhr", "Auto", "Lampe", "Stuhl", "Tasse", "Rucksack",
        "Regenschirm", "Koffer", "Pinsel", "Spiegel", "Teppich", "Kissen",
        "Schere", "Brille", "Fahrrad", "Wecker", "Leiter", "Eimer", "Besen",
        "Gabel", "Kerze", "Karton", "Handtuch", "Bilderrahmen", "Notizbuch",
        "Hammer", "Becher"
      ]
    },
    en: {
      user: [
        "Strawberry", "Banana", "Apple", "Pear", "Cherry", "Plum", "Mango",
        "Pineapple", "Melon", "Grape", "Peach", "Lemon", "Orange", "Fig",
        "Kiwi", "Apricot", "Raspberry", "Blackberry", "Date", "Papaya",
        "Tangerine", "Nectarine", "Quince", "Gooseberry", "Elderberry", "Damson"
      ],
      room: [
        "Pen", "Clock", "Car", "Lamp", "Chair", "Mug", "Key", "Umbrella",
        "Suitcase", "Brush", "Mirror", "Carpet", "Pillow", "Scissors",
        "Glasses", "Bicycle", "Alarm", "Ladder", "Bucket", "Broom",
        "Fork", "Spoon", "Candle", "Box", "Towel", "Frame"
      ]
    }
  };

  function pool(kind) {
    var set = WORDS[i18n.get()] || WORDS.en;
    return set[kind] || WORDS.en[kind];
  }

  function one(kind) {
    var list = pool(kind);
    var word = list[Math.floor(Math.random() * list.length)];
    var n = 10 + Math.floor(Math.random() * 90);   /* immer zweistellig */
    return word + n;
  }

  /* Mehrere Vorschlaege ohne Dopplung. */
  function some(kind, count) {
    var out = [];
    var guard = 0;
    while (out.length < count && guard++ < 200) {
      var candidate = one(kind);
      if (out.indexOf(candidate) === -1) out.push(candidate);
    }
    return out;
  }

  WT.names = {
    user: function (count) { return count ? some("user", count) : one("user"); },
    room: function (count) { return count ? some("room", count) : one("room"); }
  };

})(window);
