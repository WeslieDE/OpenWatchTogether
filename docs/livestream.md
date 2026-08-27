# Screen sharing (livestream)

The room master can share their screen with everyone in the room over WebRTC,
using a small SFU (Selective Forwarding Unit) — one connection per viewer, no
peer-to-peer mesh. No dedicated TURN server: the host has a public IP and the
one extra port below is opened directly.

← [Back to the setup guide](SETUP.md) · [Back to the README](../README.md)

---

## Architecture

A third long-running process joins the existing two (Apache/API and the
Workerman live connection): a Node.js process using
[mediasoup](https://mediasoup.org), started by the same `supervisord` and
shipped in the **same Docker image** — not a second container.

```
Browser (master)                 Apache :80/:443           Node (mediasoup)     PHP (Workerman)
  getDisplayMedia() ─┐                                        Router/Worker       Hub/Room
  own <video>        │ (local, instant, independent of the SFU)
                      │
  main WS   ──────────┼── /ws      (proxied) ─────────────────────────────────▶  ws/server.php
                      │                                                          (live-start / -stop / -status)
  SFU WS    ──────────┼── /sfu-ws  (proxied) ───────────────▶ signalling
  media UDP/TCP ───────────────────────────────────────────▶ one shared port (mediasoup WebRtcServer)
```

- `ws/server.php` (`src/Ws/Hub.php`) stays the single source of truth for
  "who is master" and "is a stream running". It authorises the sender with a
  short-lived HMAC token (`WT_SFU_SECRET`, shared with the SFU process) —
  there is no synchronous call between the two processes.
- The SFU process (`sfu/server.js`) itself knows nothing about rooms or a
  master. It only checks: a valid token may publish; anyone who reaches a
  room's router may watch — the same trust level as the rest of the app
  (the room slug is enough, there is no password).
- One mediasoup Router per room slug, created on the first `live-start`,
  closed again once nobody is left.
- All WebRTC connections share **one** UDP/TCP port (mediasoup's
  `WebRtcServer` feature) instead of a port range — the only port that needs
  to be reachable in addition to 80/443. Signalling itself goes through the
  same reverse-proxy path as the existing `/ws`.

Screen sharing with audio is technically two producers (video and audio),
opened by the same sender one after another; a viewer's `<video>` element
receives both tracks on the same `MediaStream`.

## Ports and environment variables

| Variable | Default | What it does |
|---|---|---|
| `WT_SFU_WS_HOST` | `127.0.0.1` | Interface the SFU signalling server listens on (internal — reached through Apache, like the main `ws`) |
| `WT_SFU_WS_PORT` | `8082` | Port of the SFU signalling server |
| `WT_SFU_WS_URL` | `/sfu-ws` in Docker, empty otherwise | Address the browser uses for SFU signalling, same convention as `WT_WS_URL` |
| `WT_SFU_PORT` | `42000` | The one media port, UDP **and** TCP, shared by every WebRTC connection |
| `WT_SFU_LISTEN_IP` | `0.0.0.0` | Interface the media port binds on |
| `WT_SFU_ANNOUNCED_IP` | *(unset)* | **Must be set** to the host's public IP/hostname in any real deployment — it's what the SFU tells browsers to connect to for media. Left unset, it only works for the container's own loopback |
| `WT_SFU_SECRET` | *(empty)* | Shared secret between `ws/server.php` and `sfu/server.js` for the sender token. Like the rest of the app, an empty value means no password protection — set it for a private deployment |

Only `WT_SFU_PORT` needs to be published from the container in addition to
80/443:

```bash
docker run --rm -p 8080:80 -p 42000:42000/udp -p 42000:42000/tcp \
  -e WT_SFU_ANNOUNCED_IP=203.0.113.10 \
  watch-together
```

## What happens when someone starts a stream

1. The master clicks **Start livestream**, the browser asks for
   `getDisplayMedia()`. The captured picture appears in the master's own
   video box immediately — independent of the SFU connection.
2. The master's browser tells `ws/server.php` (`live-start`); it checks that
   the sender really is the current master, marks the room as live, and
   replies with a signed, short-lived token.
3. Every participant (master included) is told over the main websocket that
   a stream is live. Everyone but the master opens a second connection to
   `/sfu-ws` and starts watching; the master's browser uses its token to
   start sending.
4. Each browser reports its own SFU connection state back over the main
   websocket (`live-status`); the viewer list shows it as a green/red dot
   instead of a playback position while a stream is live.
5. If a viewer's SFU connection drops, it reconnects on its own with a
   growing back-off — same pattern as the main live connection. The master's
   sending side does the same, reusing the same local capture (no repeated
   permission prompt) and asking for a fresh token.
6. The stream ends when the master stops it, closes the browser tab, loses
   the room-master role to someone else, or stops sharing via the browser's
   own "Stop sharing" control — all four are treated the same way.

While a stream is live, playback controls (play/pause/seek) are disabled for
everyone, and positions are not synchronised or broadcast at all.

## Video quality and bandwidth

The stream is a single WebRTC producer forwarded to every viewer — without
any adaptation, all viewers would be stuck with whatever quality the
weakest connection in the room could handle, and a raw, uncapped
`getDisplayMedia()` capture (native resolution and refresh rate, easily 4K
at 60fps on a modern screen) needs far more bandwidth than one usually has
free.

- **Capture is capped client-side**: `getDisplayMedia()` asks for exactly
  1920×1080 at 25fps, so a big or high-refresh screen doesn't inflate the
  source bitrate for no visual benefit on a shared video.
- **Simulcast**: the video producer sends three encodings at once — 360p,
  720p and 1080p (capped at 1000/2500/5000 kbps) — see
  `VIDEO_ENCODINGS` in `assets/js/webrtc.js`. mediasoup picks and continuously
  adjusts, *per viewer*, whichever layer that viewer's own downlink can
  currently sustain, so one struggling connection no longer drags the
  picture down (or drops frames) for everyone else. This needs no explicit
  client-side logic — mediasoup's built-in bandwidth estimation on each
  viewer's WebRTC transport drives it automatically.
- **`initialAvailableOutgoingBitrate`** on each `WebRtcTransport`
  (`sfu/server.js`) gives that estimation a realistic starting point
  (5 Mbps, matching the top simulcast layer) instead of ramping up from a
  very conservative default, so a freshly connected viewer reaches good
  quality sooner.
- **Degradation preference**: the captured track gets `contentHint =
  "motion"` (`assets/js/app.js`) so the encoder doesn't default to
  sacrificing framerate first under pressure. Left alone that would let it
  sacrifice *resolution* almost without limit instead — smooth but mushy.
  `assets/js/webrtc.js` overrides this back to `degradationPreference =
  "balanced"` on the underlying `RTCRtpSender` right after producing, so
  resolution and framerate are traded off against each other rather than
  either one being sacrificed outright.

Audio is left as a single, unscaled Opus stream — it costs little enough
that adapting it isn't worth the complexity.
