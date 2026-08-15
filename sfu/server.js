'use strict';
/* ============================================================================
 * tk.weslie.WatchTogether SFU
 *
 * Der zweite langlaufende Prozess, neben ws/server.php im selben Container.
 * PHP kann selbst kein WebRTC/SRTP sprechen - das uebernimmt hier mediasoup.
 *
 * Diese Datei kennt nichts von Raeumen, Teilnehmerlisten oder Warteschlangen.
 * Ihre einzige Aufgabe: pro Raum-Slug einen Router bereitstellen, den einen
 * Sender (Bildschirmuebertragung ist 1-zu-n) entgegennehmen und an alle
 * anderen im selben Raum weiterreichen. Wer senden darf, entscheidet allein
 * Hub.php - siehe auth.js.
 *
 * Alle WebRTC-Verbindungen teilen sich einen einzigen UDP/TCP-Port
 * (WebRtcServer). Das ist der einzige Port, der zusaetzlich zu 80/443 nach
 * aussen offen sein muss - die Signalisierung selbst laeuft ueber denselben
 * Webserver wie die Seite (Apache reicht /sfu-ws weiter, wie schon /ws).
 *
 * Eine Bildschirmuebertragung mit Ton ist technisch zwei Producer (Bild und
 * Ton je einer), die derselbe Peer nacheinander anlegt. Der Raum kennt sie
 * beide unter demselben "Sender", und wenn der geht, gehen beide zusammen.
 *
 * Nachrichten, beide Richtungen im selben {type, data}-Umschlag wie das
 * Hub-Protokoll:
 *
 *   Server an Client
 *     rtp-capabilities    Codec-Angaben des Routers, gleich nach dem Verbinden
 *     new-producer        ein Producer ist da (Bild oder Ton), auch beim Beitritt
 *     transport-created   Antwort auf create-transport
 *     transport-connected Antwort auf connect-transport
 *     produced            Antwort auf produce
 *     consumer-created    Antwort auf consume
 *     producer-closed     die ganze Uebertragung ist vorbei
 *     error                etwas ist abgelehnt worden
 *
 *   Client an Server
 *     create-transport {direction: send|recv}
 *     connect-transport {transportId, dtlsParameters}
 *     produce {transportId, kind, rtpParameters}     nur mit role=produce
 *     consume {producerId, rtpCapabilities}
 *     resume-consumer {consumerId}
 * ========================================================================= */

const mediasoup = require('mediasoup');
const { WebSocketServer } = require('ws');

const { verifyProduceToken } = require('./auth');

/* -------------------------------------------------------------- Einstellungen */

const WS_PORT      = parseInt(process.env.WT_SFU_WS_PORT || '8082', 10);
const WS_HOST      = process.env.WT_SFU_WS_HOST || '127.0.0.1';
const MEDIA_PORT   = parseInt(process.env.WT_SFU_PORT || '42000', 10);
const LISTEN_IP    = process.env.WT_SFU_LISTEN_IP || '0.0.0.0';
const ANNOUNCED_IP = process.env.WT_SFU_ANNOUNCED_IP || undefined;
const SECRET       = process.env.WT_SFU_SECRET || '';

const MEDIA_CODECS = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  {
    kind: 'video', mimeType: 'video/VP8', clockRate: 90000,
    parameters: { 'x-google-start-bitrate': 1000 },
  },
];

/* ------------------------------------------------------------------- Raeume */
/* @type {Map<string, {router: import('mediasoup').types.Router,
 *   producerPeer: string|null,
 *   producers: Map<string, import('mediasoup').types.Producer>,
 *   conns: Set<object>}>} */
const rooms = new Map();

let worker = null;
let webRtcServer = null;

async function ensureWorker() {
  if (worker) return;
  worker = await mediasoup.createWorker({ logLevel: 'warn' });
  worker.on('died', () => {
    console.error('[sfu] mediasoup-Worker ist abgestuerzt, der Prozess beendet sich.');
    process.exit(1);
  });

  webRtcServer = await worker.createWebRtcServer({
    listenInfos: [
      { protocol: 'udp', ip: LISTEN_IP, announcedIp: ANNOUNCED_IP, port: MEDIA_PORT },
      { protocol: 'tcp', ip: LISTEN_IP, announcedIp: ANNOUNCED_IP, port: MEDIA_PORT },
    ],
  });
}

async function roomOf(slug) {
  let room = rooms.get(slug);
  if (room) return room;

  await ensureWorker();
  const router = await worker.createRouter({ mediaCodecs: MEDIA_CODECS });
  room = { router, producerPeer: null, producers: new Map(), conns: new Set() };
  rooms.set(slug, room);
  return room;
}

/** Nichts mehr los im Raum: der Router geht, sonst haeuft sich das an. */
function maybeForgetRoom(slug, room) {
  if (room.conns.size > 0) return;
  room.router.close();
  rooms.delete(slug);
}

/* -------------------------------------------------------------- Verbindung */

/* Muss zu Rooms::normalize() in PHP passen - sonst stimmt die Unterschrift
   des Tokens nicht mehr ueberein, weil Hub.php mit dem dort normalisierten
   Namen rechnet. */
function slugify(raw) {
  return String(raw || '').trim().toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9äöüß\-]/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

async function handleConnection(ws, request) {
  const url = new URL(request.url, 'http://sfu.local');
  const slug = slugify(url.searchParams.get('room'));
  const peer = String(url.searchParams.get('peer') || '').slice(0, 40);
  const role = url.searchParams.get('role') === 'produce' ? 'produce' : 'consume';

  if (!slug || !peer) {
    send(ws, 'error', { message: 'room/peer fehlt' });
    ws.close();
    return;
  }

  if (role === 'produce') {
    const ok = verifyProduceToken(
      SECRET, slug, peer,
      url.searchParams.get('exp'), url.searchParams.get('sig')
    );
    if (!ok) {
      send(ws, 'error', { message: 'Token ungueltig oder abgelaufen' });
      ws.close();
      return;
    }
  }

  const room = await roomOf(slug);
  const conn = {
    ws, slug, peer, role,
    transports: new Map(),
    sendTransport: null,
    recvTransport: null,
    consumers: new Map(),
  };
  room.conns.add(conn);

  ws.on('message', (raw) => onMessage(room, conn, raw));
  ws.on('close', () => onClose(room, conn));
  ws.on('error', () => { /* "close" kommt gleich hinterher */ });

  send(ws, 'rtp-capabilities', { rtpCapabilities: room.router.rtpCapabilities });

  /* Wer als Zuschauer dazukommt, wo schon gesendet wird, erfaehrt jeden
     laufenden Producer sofort - sonst waere niemand da, der "new-producer"
     noch einmal schickt. */
  if (role === 'consume') {
    room.producers.forEach((producer) => {
      send(ws, 'new-producer', { producerId: producer.id, kind: producer.kind });
    });
  }
}

function onClose(room, conn) {
  conn.consumers.forEach((c) => c.close());
  conn.transports.forEach((t) => t.close());
  room.conns.delete(conn);

  if (conn.role === 'produce' && room.producerPeer === conn.peer) {
    stopProducing(room);
  }
  maybeForgetRoom(conn.slug, room);
}

/** Der Sender ist weg - ob gewollt beendet oder weil die Leitung abriss.
    Bild und Ton (falls beides da war) gehen zusammen. */
function stopProducing(room) {
  if (room.producers.size === 0) return;
  room.producers.forEach((producer) => producer.close());
  room.producers.clear();
  room.producerPeer = null;
  room.conns.forEach((c) => {
    if (c.role === 'consume') send(c.ws, 'producer-closed', {});
  });
}

/* -------------------------------------------------------------- Nachrichten */

async function onMessage(room, conn, raw) {
  let msg = null;
  try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
  if (!msg || typeof msg.type !== 'string') return;
  const d = msg.data && typeof msg.data === 'object' ? msg.data : {};

  try {
    switch (msg.type) {

      case 'create-transport': {
        const transport = await room.router.createWebRtcTransport({
          webRtcServer,
          enableUdp: true,
          enableTcp: true,
          preferUdp: true,
        });
        transport.on('dtlsstatechange', (state) => {
          if (state === 'closed' || state === 'failed') transport.close();
        });
        conn.transports.set(transport.id, transport);
        if (d.direction === 'send') conn.sendTransport = transport;
        else conn.recvTransport = transport;

        send(conn.ws, 'transport-created', {
          id: transport.id,
          direction: d.direction === 'send' ? 'send' : 'recv',
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
        });
        break;
      }

      case 'connect-transport': {
        const transport = conn.transports.get(String(d.transportId));
        if (!transport) break;
        await transport.connect({ dtlsParameters: d.dtlsParameters });
        send(conn.ws, 'transport-connected', { transportId: transport.id });
        break;
      }

      /* Nur der aktuelle Sender darf produzieren - eine Bildschirmuebertragung
         hat genau eine Quelle, wenn auch aus bis zu zwei Producern (Bild und
         Ton). Eine neue Anmeldung eines anderen Peers loest die vorige ab,
         statt sie abzulehnen; der Raum selbst weiss nicht, wer gerade Master
         ist, das hat Hub.php schon beim Ausstellen des Tokens entschieden. */
      case 'produce': {
        if (conn.role !== 'produce') break;
        const transport = conn.transports.get(String(d.transportId));
        if (!transport) break;

        if (room.producerPeer && room.producerPeer !== conn.peer) {
          stopProducing(room);
        }

        const producer = await transport.produce({
          kind: d.kind, rtpParameters: d.rtpParameters,
        });
        producer.on('transportclose', () => {
          if (room.producers.get(producer.id) === producer) stopProducing(room);
        });

        room.producers.set(producer.id, producer);
        room.producerPeer = conn.peer;

        send(conn.ws, 'produced', { id: producer.id });
        room.conns.forEach((c) => {
          if (c.role === 'consume' && c !== conn) {
            send(c.ws, 'new-producer', { producerId: producer.id, kind: producer.kind });
          }
        });
        break;
      }

      case 'consume': {
        const transport = conn.recvTransport;
        if (!transport) break;
        if (!room.producers.has(String(d.producerId))) break;
        if (!room.router.canConsume({ producerId: d.producerId, rtpCapabilities: d.rtpCapabilities })) {
          send(conn.ws, 'error', { message: 'kann nicht konsumiert werden' });
          break;
        }

        const consumer = await transport.consume({
          producerId: d.producerId,
          rtpCapabilities: d.rtpCapabilities,
          paused: true,
        });
        conn.consumers.set(consumer.id, consumer);
        /* Das eigentliche "der Sender ist weg" kommt gesammelt aus
           stopProducing() - hier wird nur der eigene Verweis aufgeraeumt. */
        consumer.on('producerclose', () => conn.consumers.delete(consumer.id));

        send(conn.ws, 'consumer-created', {
          id: consumer.id,
          producerId: d.producerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
        });
        break;
      }

      case 'resume-consumer': {
        const consumer = conn.consumers.get(String(d.consumerId));
        if (consumer) await consumer.resume();
        break;
      }

      default:
        break;
    }
  } catch (err) {
    send(conn.ws, 'error', { message: String((err && err.message) || err) });
  }
}

function send(ws, type, data) {
  if (ws.readyState !== ws.OPEN) return;
  try { ws.send(JSON.stringify({ type, data: data || {} })); } catch (e) { /* schon zu */ }
}

/* -------------------------------------------------------------------- Start */

const wss = new WebSocketServer({ host: WS_HOST, port: WS_PORT });
wss.on('connection', (ws, request) => {
  handleConnection(ws, request).catch((err) => {
    console.error('[sfu] Verbindung fehlgeschlagen:', err);
    try { ws.close(); } catch (e) { /* schon zu */ }
  });
});

console.log(`[sfu] Signalisierung auf ${WS_HOST}:${WS_PORT}, Medien auf Port ${MEDIA_PORT} (UDP+TCP)`);
