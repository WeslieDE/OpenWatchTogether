# HLSStream — Räume als HLS-Stream

Jeder Raum ist zusätzlich unter einer festen URL als HLS-Stream abrufbar —
für einen normalen Video-Player, ein Smart-TV, Chromecast oder OBS, ganz ohne
die Web-Oberfläche. Zu sehen ist genau das, was im Raum gerade läuft: eine
Videodatei an der aktuellen Wiedergabeposition, eine laufende
Bildschirmübertragung live, oder ein Standbild, wenn gerade nichts läuft oder
pausiert ist.

← [Back to the setup guide](SETUP.md) · [Back to the README](../README.md)

---

## Die URL

```
https://<host>/stream/<Raumname>.m3u8
```

Der Raumname wird genauso normalisiert wie beim Betreten des Raums im
Browser (`Rooms::normalize()`/`slugify()`) — Groß-/Kleinschreibung und
führende/nachfolgende Bindestriche spielen keine Rolle.

## Architektur

Ein vierter, komplett eigenständiger Prozess neben Apache/API, der
Live-Verbindung (`ws/server.php`) und dem SFU (`sfu/server.js`) — geschrieben
in Go (siehe unten, warum), im selben Docker-Image, von `supervisord`
gestartet. Er kennt weder `Hub.php` noch `Room.php` von innen: er klinkt sich
in jeden Raum, den mindestens ein HLS-Zuschauer gerade abruft, wie ein ganz
normaler Browser-Client per WebSocket ein (`?room=&name=HLSStream`) und hält
sich an genau dasselbe Protokoll. Läuft in dem Raum eine
Bildschirmübertragung, verbindet er sich zusätzlich als `role=consume`-Peer
beim SFU.

```
Video-Client (HLS)          Apache :80/:443           HLSStream (Go)         PHP (Hub)      Node (SFU)
  GET /stream/<raum>.m3u8 ────┼─ proxy (nur *.m3u8) ──▶ Playlist-Handler
  GET /stream-seg/<raum>/…ts ─┼─ Alias → HLSStream/data ▶ (Datei direkt, Go sieht das nie)
                               │                              │
                               │                        WS ───┼───────────────▶ ws/server.php
                               │                              │  (Peer "HLSStream": video/now/settings/live)
                               │                        WS ───┼───────────────────────────────▶ sfu/server.js
                               │                              │  (role=consume, Plain-RTP)
```

- **Beitritt nur bei Bedarf.** Erst der erste Aufruf der Playlist eines Raums
  lässt HLSStream diesen Raum betreten; ruft niemand mehr ab (Standard:
  30 Sekunden ohne Playlist-Request — `WT_HLS_IDLE_SECONDS`), verlässt er ihn
  wieder. HLS kennt keine dauerhafte Verbindung, deshalb ist der
  Playlist-Abruf selbst das einzig verfügbare Anwesenheitssignal — die
  30 Sekunden sind bewusst grosszügig bemessen, damit ein kurzer
  Verbindungsabbruch beim Zuschauer (Mobilfunk, WLAN-Aussetzer) nicht sofort
  den ganzen Encoder-Prozess beendet, sondern der Stream bei seiner Rückkehr
  einfach weiterläuft.
- **Kein eigener Takt, keine Steuerung.** HLSStream sendet nie `video`,
  `now` oder `take` — es folgt nur dem, was der jeweilige Taktgeber
  vorgibt, genau wie ein stummer Zuschauer. Ist im Raum der
  ["Bereit-Modus"](../README.md#-ready-when-everyone-is-optional) aktiv,
  meldet es sofort und immer "bereit" (`go`), damit es den Raum niemals
  aufhält.
- **Meldet jedes Video sofort als geladen.** Der Taktgeber lässt ein neues
  Video erst anlaufen, wenn ihm jeder Teilnehmer `ready` für dieses Video
  gemeldet hat (siehe `startWhenAllReady()` in `assets/js/app.js`) — ohne
  diese Meldung bliebe der Platz von HLSStream dauerhaft "nicht bereit" und
  hielte jeden automatischen Videostart im ganzen Raum auf. Da HLSStream
  Datei/Live/Standbild beim Quellwechsel ohnehin nahtlos austauscht (siehe
  unten), muss dafür nie wirklich etwas gepuffert werden — es meldet `ready`
  deshalb sofort bei jedem `now` und beim `welcome` nach dem (Wieder-)Beitritt.
- **Meldet auch seine Position, im selben Takt wie ein Browser** (jede
  Sekunde, siehe `POS_MS` in `assets/js/net.js`) — sonst stünde es in der
  Teilnehmerliste dauerhaft bei 0:00. Da HLSStream ohnehin nur die vom
  Taktgeber gemeldete Zeit hochrechnet, um seine eigene Quelle zu steuern
  (`desired()`/`currentPosition()`), meldet es genau diesen Wert zurück.
- **Liefert sofort ein vorgerendertes Standbild-Segment, bis der eigene
  Encoder steht.** Bis zum allerersten echten Segment eines frisch
  betretenen Raums vergehen der Reihe nach: Handshake zum Hub, Start des
  passenden Quell-Prozesses, ein volles GOP (2s) durch den Encoder — spürbar
  länger, als mancher HLS-Player auf ein erstes Segment wartet, bevor er das
  Laden als fehlgeschlagen abbricht. `pipeline.RenderHold()` rendert deshalb
  einmalig beim Start des Dienstes ein einzelnes, eigenständiges
  HLS-Segment aus dem Standbild, in denselben Codec-Parametern wie der
  Encoder. Fragt ein Player die Playlist eines Raums ab, dessen echte
  `index.m3u8` noch nicht existiert, bekommt er statt eines `503` sofort eine
  Ein-Segment-Playlist auf dieses vorgerenderte Segment (`/stream/_hold.ts`)
  — dieselbe einzige Ausnahme von "Segmente laufen an Apache vorbei", weil
  es nicht pro Zuschauer, sondern nur kurz nach jedem Raumbeitritt gebraucht
  wird. Sobald ffmpeg sein erstes echtes Segment geschrieben hat, bekommt der
  Player beim nächsten Poll ganz normal dessen `index.m3u8`.
- **Segmente laufen an Apache vorbei am Go-Prozess vorbei zum Zuschauer** —
  wie schon die Videos selbst unter `/media` liefert Apache sie direkt aus
  dem Dateisystem (`HLSStream/data/<raum>/`). HLSStream sieht dadurch pro
  Wiedergabe nur die schlanken Playlist-Requests, nicht die eigentlichen
  Videodaten — wichtig für einen Dienst, der lange am Stück laufen und viele
  gleichzeitige Zuschauer aushalten soll, ohne dass RAM/Verbindungen mit der
  Zuschauerzahl mitwachsen.

## Warum Go

Der Dienst muss lange am Stück laufen und viele Zuschauer gleichzeitig
aushalten, ohne dass der Speicherverbrauch mit der Zeit oder der
Verbindungszahl davonläuft. Go kompiliert zu einem einzigen statischen
Binary ohne eigenes Laufzeitsystem im Container, Goroutinen sind pro
Verbindung extrem billig, und `os/exec` mit weitergereichten Dateideskriptoren
(`cmd.ExtraFiles`) ist die Grundlage für den nahtlosen Quellwechsel unten -
robust, ohne externe Prozess-Management-Bibliothek.

## Nahtloser Quellwechsel

Der eigentliche HLS-Stream reißt nie ab — auch nicht bei Pause, Videowechsel
oder dem Wechsel von einer Datei auf eine laufende Bildschirmübertragung.
Der Trick: pro Raum läuft **ein** dauerhafter ffmpeg-Encoder-Prozess, der
Video und Ton über zwei rohe, nie geschlossene Pipes liest und daraus
fortlaufend H.264/AAC-HLS schreibt. Nur der Prozess, der gerade in diese
Pipes *hineinschreibt* ("Quelle"), wird ausgetauscht:

- **Datei-Wiedergabe** — die aktuell im Raum laufende Videodatei, ab der vom
  Taktgeber gemeldeten Position, in Echtzeit gelesen (`-re`).
- **Live-Relay** — die laufende Bildschirmübertragung, per Plain-RTP vom SFU
  bezogen (siehe unten) und genauso reencodiert.
- **Standbild** — `HLSStream/assets/VideoPaused.png`, sobald gerade nichts
  läuft oder pausiert ist.

Ein Wechsel beendet den alten Quell-Prozess und startet sofort einen neuen
mit denselben Pipe-Enden — der Encoder merkt davon höchstens einen kurzen
Stillstand von einigen hundert Millisekunden, nie einen Abriss der
Playlist. Die periodischen ~2-Sekunden-Taktmeldungen des Raums selbst lösen
**keinen** Neustart aus (das würde ständig stottern) — nur ein tatsächlicher
Wechsel (anderes Video, Play/Pause, ein Sprung von mehr als 2 Sekunden
gegenüber der eigenen Hochrechnung, oder Beginn/Ende einer
Bildschirmübertragung).

### Bild und Ton bleiben auch über viele Wechsel synchron

Bild und Ton laufen als zwei getrennte ffmpeg-Prozesse in die beiden rohen
Pipes (siehe oben) — der Encoder zählt seine Zeitstempel dabei rein aus der
Anzahl gelesener Bilder bzw. Samples (24fps/48kHz, siehe `encoder.args()`),
nie aus tatsächlicher Ankunftszeit. Ein Bild-Quellprozess braucht bis zu
seinem ersten Bild aber spürbar länger als der zugehörige Ton-Prozess —
Datei-Decoder und Filtergraph-Aufbau kosten gemessen ein paar hundert
Millisekunden, eine triviale Stille oder ein Audio-Codec dagegen kaum mehr
als 30ms. Ohne Gegenmaßnahme schriebe jeder Wechsel diesen Unterschied
dauerhaft in den Versatz zwischen Bild und Ton ein — ein Stückchen bei jedem
Play/Pause und Videowechsel, das sich über die Laufzeit des Raums spürbar
aufsummiert.

`pipeline.startVideoSynced()` lässt den Ton-Prozess deshalb erst los, sobald
der Bild-Prozess sein erstes Bild wirklich ausgegeben hat — erkannt über
eine eigene, kurzlebige `-progress`-Pipe des Bild-Prozesses (mit
Sicherheitsnetz: nach spätestens 2 Sekunden geht es so oder so weiter). Die
Verzögerung dabei ist derselbe kurze Stillstand, den ein Quellwechsel ohnehin
schon macht (siehe oben) — es wird nur nichts mehr Unsynchrones daraus.

## Live-Relay über eine Plain-RTP-Erweiterung des SFU

Der bestehende SFU-Prozess (`sfu/server.js`, mediasoup) spricht mit
Browsern nur WebRTC (ICE/DTLS/SRTP). HLSStream ist kein Browser und braucht
das nicht — es bekommt das RTP stattdessen direkt an einen selbst gewählten
lokalen Port geschickt. Dafür hat der SFU zwei neue, generische
Nachrichtentypen bekommen (kein Sonderfall für HLSStream, sondern eine RTP-
Ausgabe für beliebige Consumer ohne eigenes WebRTC):

- `create-plain-transport` / `connect-plain-transport` — das Plain-RTP-
  Gegenstück zu `create-transport`/`connect-transport`.
- `consume`/`resume-consumer` danach sind identisch zum bestehenden
  Protokoll (`PlainTransport` erbt von derselben Mediasoup-Basisklasse wie
  `WebRtcTransport`).

HLSStream baut daraus eine minimale SDP-Datei (VP8-Bild, optional
Opus-Ton) und liest sie mit `ffmpeg -protocol_whitelist file,udp,rtp`.
Fehlt eine Tonspur (Bildschirmübertragung ohne freigegebenes Mikrofon), wird
Stille beigemischt.

## Encoding

720p/24fps/Stereo, auf breite (auch ältere) Android-Hardware-Decoder
ausgelegt:

| Parameter | Wert |
|---|---|
| Auflösung | 1280×720, feste, gerade Kantenlängen (ungerade/krumme Werte sind ein bekannter Absturzgrund für mobile Hardware-Decoder) |
| Bildrate | 24fps, fest (`fps`-Filter für alle drei Quellarten) |
| Video | H.264, `profile main`, `level 3.1`, `yuv420p` |
| GOP | 48 Bilder = exakt 2 Sekunden, kein zusätzlicher Scene-Cut-Keyframe (`sc_threshold 0`) — jedes Segment beginnt exakt auf einem Keyframe |
| Ton | AAC, 2 Kanäle, 48kHz, 128kbps |
| Segmente | MPEG-TS, 2 Sekunden, Fenster von 8 Segmenten (~16s) |

Das ist bewusst *praktisch* latenzarm (kurze, aber normale HLS-Segmente)
statt vollem Low-Latency-HLS mit Partial Segments — die sind auf vielen
mobilen Playern/Hardware-Decodern nach wie vor unzuverlässig, während kurze,
keyframe-ausgerichtete Standardsegmente überall zuverlässig laufen.

## Umgebungsvariablen

| Variable | Vorgabe | Was sie tut |
|---|---|---|
| `WT_HLS_HTTP_HOST` | `127.0.0.1` | Interface, auf dem der Playlist-Server lauscht |
| `WT_HLS_HTTP_PORT` | `8083` | Sein Port (intern, Apache reicht `/stream/` dorthin durch) |
| `WT_HLS_IDLE_SECONDS` | `30` | Wie lange ein Raum ohne Playlist-Abruf aktiv bleibt, bevor HLSStream ihn verlässt |
| `WT_HLS_FFMPEG` / `WT_HLS_FFPROBE` | `ffmpeg` / `ffprobe` (aus PATH) | Pfad zu den Programmen |
| `WT_HLS_DATA_DIR` | `/var/www/html/HLSStream/data` | Wohin Playlists/Segmente je Raum geschrieben werden |
| `WT_HLS_PAUSED_IMAGE` | `/var/www/html/HLSStream/assets/VideoPaused.png` | Das Standbild |

Kein zusätzlicher externer Port nötig — anders als beim SFU (Medienport
42000) läuft der gesamte HLS-Verkehr über Apache 80/443, weil HLS reines
HTTP ist.
