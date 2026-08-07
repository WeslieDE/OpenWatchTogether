# Setup Guide

Everything you need to get Watch Together running — from a one-line Docker
command to a manual PHP install behind your own reverse proxy.

← [Back to the README](../README.md)

**Contents**

1. [Requirements](#requirements)
2. [Install with Docker](#install-with-docker)
3. [Install with Docker Compose](#install-with-docker-compose)
4. [Behind a reverse proxy / HTTPS](#behind-a-reverse-proxy--https)
5. [Manual installation without Docker](#manual-installation-without-docker)
6. [Development on Windows with XAMPP](#development-on-windows-with-xampp)
7. [Configuration reference](#configuration-reference)
8. [Nothing survives a restart — and why that's good](#nothing-survives-a-restart--and-why-thats-good)
9. [Pre-filling new rooms with the `default/` folder](#pre-filling-new-rooms-with-the-default-folder)
10. [Where your data lives](#where-your-data-lives)
11. [Technical details](#technical-details)
12. [Housekeeping](#housekeeping)
13. [Troubleshooting](#troubleshooting)

---

## Requirements

**With Docker** — just Docker. Nothing else.

**Without Docker:**

| | |
|---|---|
| PHP | 8.0 or newer, CLI **and** for the web server |
| PHP extensions | `pdo_sqlite`, `json`; `pcntl` recommended for the live process |
| Web server | Apache or nginx pointing at the project folder |
| Composer | to install dependencies |
| ffmpeg | `ffmpeg` and `ffprobe` — optional, see [below](#is-ffmpeg-really-optional) |

No database server, no Redis, no accounts. Each room keeps its own small SQLite
file.

---

## Install with Docker

Everything runs in a **single container**: Apache with the API, and next to it
the long-running process for the live connection, both kept alive by
`supervisord`.

```bash
git clone https://github.com/WeslieDE/OpenWatchTogether.git
cd OpenWatchTogether

docker build -t watch-together .
docker run --rm -p 8080:80 watch-together
```

Open <http://localhost:8080>, pick a room name, pick your name — done. Send the
URL from your address bar to whoever should join.

Use a different port by changing the left half of `-p`, e.g. `-p 9000:80` for
<http://localhost:9000>.

> **No volume needed — on purpose.**
> Watch Together is designed to be disposable. Rooms and videos live as long as
> the container runs; a restart wipes everything clean. That keeps your disk tidy
> and means you never have to deal with leftovers from last month's movie night.
> Details: [Nothing survives a restart](#nothing-survives-a-restart--and-why-thats-good).

---

## Install with Docker Compose

`docker-compose.yml`:

```yaml
services:
  watch-together:
    build: .
    # or, if you built the image yourself: image: watch-together
    container_name: watch-together
    ports:
      - "8080:80"
    restart: unless-stopped
    # Optional — every setting has a sensible default:
    # environment:
    #   WT_MAX_BYTES: "0"        # 0 = no upload size limit
    #   WT_SEED: "1"             # pre-fill brand-new rooms from ./default
```

No `volumes:` entry — that is intentional, see
[Nothing survives a restart](#nothing-survives-a-restart--and-why-thats-good).

```bash
docker compose up -d          # start
docker compose logs -f        # watch it come up
docker compose down           # stop (and wipe, unless you mounted a volume)
```

---

## Behind a reverse proxy / HTTPS

The live connection runs through the **same port as the website** (`/ws`), so
only port 80 of the container needs to be reachable. Serve it over HTTPS and the
browser switches to secure WebSockets (`wss`) by itself — no extra setting.

Your proxy only has to forward WebSocket upgrades.

**nginx**

```nginx
server {
    server_name watch.example.com;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host       $host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        client_max_body_size 0;     # uploads are chunked, but don't cap them
        proxy_read_timeout 3600s;   # keep the live connection open
    }
}
```

**Caddy**

```caddy
watch.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

**Traefik** (labels on the compose service)

```yaml
labels:
  - "traefik.enable=true"
  - "traefik.http.routers.watchtogether.rule=Host(`watch.example.com`)"
  - "traefik.http.services.watchtogether.loadbalancer.server.port=80"
```

Caddy, Traefik and Nginx Proxy Manager handle WebSockets by default — nothing
extra to configure there.

---

## Manual installation without Docker

Watch Together needs **two things running**: your web server for the page and
the API, and one long-running PHP process for the live connection.

### 1. Get the code and dependencies

```bash
git clone https://github.com/WeslieDE/OpenWatchTogether.git
cd OpenWatchTogether
composer install --no-dev --optimize-autoloader
```

### 2. Point your web server at the folder

The document root is the project folder itself. `api/`, `src/`, `bin/` and
`docker/` are protected by `.htaccess`; on nginx, deny them explicitly:

```nginx
root /var/www/watch-together;
index index.html;

location ~ ^/(src|bin|docker|vendor|ws)/ { deny all; }

location ~ \.php$ {
    fastcgi_pass unix:/run/php/php8.3-fpm.sock;
    include fastcgi_params;
    fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
    fastcgi_read_timeout 3600;
}
```

### 3. Start the live connection

```bash
php ws/server.php start
```

It has to keep running while people are watching. For a real installation, run
it under systemd:

```ini
# /etc/systemd/system/watch-together-ws.service
[Unit]
Description=Watch Together live connection
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/var/www/watch-together
ExecStart=/usr/bin/php /var/www/watch-together/ws/server.php start
Restart=always
Environment=WT_WS_URL=/ws

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now watch-together-ws
```

### 4. Tell the browser where the live connection is

- **Same port as the website** (recommended, needs a proxy rule like the ones
  above): `WT_WS_URL=/ws`
- **Separate port** (simplest for a quick test): leave `WT_WS_URL` empty — the
  browser then connects to `ws://<host>:8081` and that port must be reachable.

### Is ffmpeg really optional?

Yes. `ffmpeg` determines each video's runtime and cuts the thumbnail (a frame at
20% of the video, JPEG, max 420p). Without it, the browser supplies both from the
selected file instead. Everything else works exactly the same.

---

## Development on Windows with XAMPP

```
composer install
```

ffmpeg can sit portably in the project under `tools/ffmpeg/bin`. If it isn't
there, the `PATH` is used.

Then start two things:

1. **Apache** from the XAMPP control panel.
2. **The live connection**, in its own window:

   ```
   bin\ws.cmd
   ```

Open <http://localhost/WatchTogether/>. The window running the live connection
has to stay open while anyone is watching.

For local settings, copy `config.local.php.example` to `config.local.php` and
edit it — it takes precedence over everything else and is only meant for
development. In containers, use environment variables instead.

---

## Configuration reference

Every setting is an environment variable, and every one has a sensible default.

| Variable | Default | What it does |
|---|---|---|
| `WT_DATA_DIR` | `~/.weslie/WatchTogether`, `/data` in Docker | Where videos, thumbnails and room databases live |
| `WT_MAX_BYTES` | `0` | Maximum size per file — `0` means **no limit** |
| `WT_CHUNK_BYTES` | `4194304` | Size of a single upload chunk (4 MB) |
| `WT_WS_URL` | `/ws` in Docker, empty otherwise | Address the browser uses for the live connection. Empty = `ws://<host>:<port>`, a `/path` = behind the same web server |
| `WT_WS_HOST` | `0.0.0.0` | Interface the live process listens on |
| `WT_WS_PORT` | `8081` | Port of the live process |
| `WT_FFMPEG` | `tools/ffmpeg/bin`, else `PATH` | Path to `ffmpeg` |
| `WT_FFPROBE` | same | Path to `ffprobe` |
| `WT_SEED` | `1` | Pre-fill brand-new rooms from `default/` — `0` disables it |
| `WT_DEFAULT_DIR` | `default/` in the project folder | Where those starter videos live |

### Upload limits

Uploads are sent in chunks, so PHP's `upload_max_filesize` and `post_max_size`
never come into play — **there is no file size limit by default**, and nothing in
`php.ini` needs tuning. Each chunk names its own offset; if it doesn't line up
with what the server already has, it's rejected.

If you *want* a limit for your installation, set `WT_MAX_BYTES` to a number of
bytes (e.g. `5368709120` for 5 GB).

---

## Nothing survives a restart — and why that's good

**Watch Together deliberately deletes every uploaded video and every room when
the service restarts.** This is not a limitation, it is the design:

- **Nothing piles up.** A watch party leaves no trace. You never come back
  months later to a disk full of films nobody remembers uploading.
- **No volume required.** There is no state worth preserving, so the container
  needs no volume, no bind mount, no backup and no permissions juggling. Pull a
  new image, restart, done.
- **Restarting is the reset button.** Something stuck? Queue in a weird state?
  Restart the container and you have a clean installation again.

What that means in practice:

| Event | What happens |
|---|---|
| Service / container restarts | **All** rooms, videos, thumbnails and queues are deleted |
| A video finishes playing | That file is removed from the server automatically |
| Someone removes a video from the queue | The file and its thumbnail are deleted |
| A room sits empty for a while | Nothing — rooms and their videos stay until the restart |
| Six hours pass on an abandoned partial upload | The leftover chunks are cleaned up |

There is **no expiry timer**. As long as the service keeps running, your room
and its queue stay exactly as you left them — including the position of the video
you paused, so you can pick it up again the next evening.

Videos placed in the [`default/` folder](#pre-filling-new-rooms-with-the-default-folder)
are the exception: they are part of the installation, not of a room, and are
never deleted.

> **Want uploads to persist anyway?** Mount a volume at `/data`
> (`-v watchtogether-data:/data`). The startup wipe still runs, so if you want
> genuinely permanent storage, also override the entrypoint — but at that point
> you're using the tool against its grain.

---

## Pre-filling new rooms with the `default/` folder

Want a room that's never empty? Put videos into `default/<roomname>/`. They move
into the queue automatically the first time somebody enters that room while it is
still **empty and nobody is in it**:

```
default/
  livingroom/
    01 Trailer.mp4
    02 Main feature.mp4
```

- The folder may be named after the **room** (`livingroom`) or its internal room
  ID — checked in that order.
- Only browser-playable formats count; anything else in the folder is skipped.
- Files are ordered by name, which is why numbering them pays off.
- Runtime and thumbnail are generated just like after an upload.
- In the queue these show up as *available in the room* rather than added by a
  person.

Your originals are never touched. The room gets its own directory entry — a hard
link where possible, so it costs no extra disk space and no time. Removing such a
video inside a room only removes the room's entry; the original stays and comes
back with the next empty room. `WT_SEED=0` turns the whole thing off.

---

## Where your data lives

Everything persistent lives **outside the web root**, under `WT_DATA_DIR`
(`/data` in the container):

```
media/<RoomID>/
    room.txt        the room name in plain text
    room.sqlite     queue, runtimes, who added what, last position
    <random>.mp4    the video
    <random>.jpg    its thumbnail, same name
    parts/          uploads in progress
```

The room ID is a hash of the room name. Uploaded files are renamed to random,
unique names and are only ever served through the API — nobody can guess a URL
and stumble into your files.

Your own name, theme and volume are stored in your browser's local storage
(`wt.name`, `wt.theme`, `wt.volume`, `wt.muted`). They never travel over the
connection.

---

## Technical details

### Architecture

The whole site is a **single HTML page**. It talks to the server two ways:

```
                  ┌──── AJAX (HTTP) ────▶  api/index.php     uploads, rooms,
Browser  ─────────┤                                          queue, video delivery
 (index.html)     └──── WebSocket ──────▶  ws/server.php     positions, play state,
                                                             who's in the room
```

| Part | Runs on |
|---|---|
| Page & API | PHP 8 behind Apache/nginx — plain request/response, no framework |
| Live connection | A long-running PHP process using [Workerman](https://github.com/walkor/workerman) |
| Per-room storage | One SQLite file per room (`room.sqlite`) |
| Runtime & thumbnails | `ffmpeg` / `ffprobe`, called once per upload |

Namespaces follow `tk\weslie\WatchTogether\…` (`src/`), the frontend modules
`tk.weslie.WatchTogether.…` (`assets/js/`).

### The HTTP API

Everything goes through `api/index.php?do=…` and answers with JSON.

| Call | What it does |
|---|---|
| `config` | What the browser needs to know before it starts |
| `room` | Enter or create a room, returns the queue |
| `queue` | The room's queue |
| `upload-begin` | Announce a transfer, returns an ID and the chunk size |
| `upload-chunk` | Append one chunk — raw in the body, offset in the query |
| `upload-finish` | Rename, probe runtime, cut thumbnail, add to the queue |
| `upload-abort` | Throw the transfer away |
| `remove` | Delete a video, its file and its thumbnail |
| `media` | Serve a video, with range requests so seeking works |
| `poster` | Serve a thumbnail |

Uploads are chunked (4 MB by default). That avoids large values in `php.ini`,
makes the progress bar accurate, and lets a transfer be cancelled at any moment.
Every chunk states its offset; if it doesn't match the length already stored, the
server rejects it.

After the last chunk, `ffmpeg` reads the runtime and cuts a still frame at 20% of
the video — JPEG, at most 420p, stored next to the video under the same name.

### The live connection

`ws/server.php` keeps the state of all rooms in memory and distributes messages.
Only what is necessary travels over the wire.

**Server → client**

| Message | Contents |
|---|---|
| `welcome` | The complete room state on connect |
| `joined` / `left` | Somebody arrived or went |
| `named` | Somebody renamed themselves |
| `master` | Who is currently setting the pace |
| `video` | Playing or paused, plus the time, from the pacesetter |
| `pos` | The other viewers' positions, once a second |
| `upload` / `upload-end` | A transfer's progress, and its end or abort |
| `queue` | The queue, whenever it changed |
| `now` | Which video is playing |

**Client → server**

| Message | Contents |
|---|---|
| `pos` | Own position, once a second |
| `video` | Pacesetter only: on every change, plus every 2 seconds |
| `take` | Take over control |
| `name` | Own name changed |
| `upload` / `upload-end` | Own transfer's progress, every 2 seconds, and its end |
| `changed` | Something about the queue changed |
| `now` | Pacesetter only: which video is playing |
| `bye` | Close the connection |

**Volume and mute are deliberately never sent.** Everyone controls their own
sound; the setting stays in the browser.

Between two messages from the pacesetter, each client extrapolates the position
itself — otherwise the display would jump in two-second steps.

If the connection drops it is re-established with growing back-off, and `welcome`
restores the full state.

### How syncing works

- One viewer is the **pacesetter**. Anyone who presses play, pause or touches the
  timeline becomes the pacesetter automatically; there is also an explicit button.
- The pacesetter broadcasts its position every 2 seconds, plus immediately on
  every change.
- **Drift up to ±20 s:** the lagging client plays 20% faster or slower until it
  has caught up. No jump, no stutter — just a small note above the picture.
- **Drift beyond 20 s:** the client seeks hard to the correct position and says so
  in a dialog.
- Viewers who are noticeably off are highlighted in the viewer list, and every
  viewer's position is shown as a marker on the timeline.

### Pause now, continue later

When the last viewer leaves — and on every pause — the current position is written
into the room's SQLite file. It therefore survives an empty room and even a
restart of the live process.

Whoever wakes the room up again receives it in `welcome` as `resume`: the video is
loaded **paused, at exactly that spot**. If the stored position no longer fits the
video, or sits right before its end, playback starts from the beginning instead.

### Formats

Only what the browser plays without conversion is accepted — MP4, WebM, OGG and
whatever else `canPlayType` confirms. Nothing is ever transcoded, which is why
playback starts instantly. MKV, AVI and similar are rejected with a hint; the rest
of a multi-file selection still uploads.

### Languages

English and German. The browser's language decides; anything else falls back to
English. Labels in the markup hang off `data-i18n`, strings from code go through
`i18n.t()`.

---

## Housekeeping

Rooms and videos stay as long as the service runs. There is no timer that makes
things disappear on their own — a restart clears the lot (the container's
entrypoint wipes `/data` on startup).

During operation only orphaned data is removed: partial uploads nobody has
touched for six hours. That runs in the background of the live process every
15 minutes, and opportunistically on API calls at most once every ten minutes.

By hand:

```bash
php bin/cleanup.php          # leftover partial uploads
php bin/cleanup.php --wipe   # everything, like a fresh start
```

---

## Troubleshooting

**Viewers see each other but playback doesn't sync**
The live connection isn't getting through. Check that `ws/server.php` is running
and that your reverse proxy forwards WebSocket upgrades (`Upgrade` /
`Connection: upgrade`). The browser console will show a failed connection to
`/ws`.

**"Mixed content" or blocked connection on an HTTPS site**
The page is on `https://` but the live connection is trying plain `ws://`. Use
`WT_WS_URL=/ws` and let it run behind the same web server — it then upgrades to
`wss://` automatically.

**Uploads fail part way through**
Usually a proxy body-size limit. Set `client_max_body_size 0;` (nginx) or the
equivalent, so individual 4 MB chunks aren't rejected.

**No thumbnails, no runtimes**
`ffmpeg`/`ffprobe` weren't found. Install them, or point `WT_FFMPEG` and
`WT_FFPROBE` at them. Playback is unaffected either way.

**A file is rejected when adding it**
Only formats the browser plays without conversion are accepted — MP4, WebM, OGG
and whatever else `canPlayType` confirms. MKV, AVI and friends are refused on
purpose; nothing is transcoded, so playback can start instantly.

**Everything disappeared after a restart**
Working as designed — see the note about volumes in
[Install with Docker](#install-with-docker).
