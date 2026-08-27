#!/usr/bin/env bash
# Baut das Image und startet es lokal zum Testen - inklusive SFU-Port fuer
# die Bildschirmuebertragung. "docker" laesst sich 1:1 durch "podman"
# ersetzen, beide verstehen dieselben Argumente.
set -euo pipefail

IMAGE=weslie/watchtogether
NAME=watchtogether-test
PORT=8889
# Liegt schon in .gitignore. Ausserhalb des Containers sichtbar, damit sich
# das neue /media-Alias auch mit einer echten Datei durchtesten laesst.
DATA_DIR="$(pwd)/data"

docker build -t "$IMAGE" .

docker rm -f "$NAME" >/dev/null 2>&1 || true

mkdir -p "$DATA_DIR"
# www-data im Container schreibt sonst gegen ein Verzeichnis, das dem
# Host-Benutzer gehoert - fuer einen lokalen Testlauf reicht das hier. Nach
# dem ersten Lauf gehoert der Ordner bereits www-data (der Container raeumt
# beim Start auf); dann darf chmod ruhig scheitern, es ist schon offen genug.
chmod 777 "$DATA_DIR" 2>/dev/null || true

docker run -d --name "$NAME" \
  -p "$PORT":80 \
  -p 42000:42000/tcp \
  -p 42000:42000/udp \
  -e WT_SFU_ANNOUNCED_IP=127.0.0.1 \
  -v "$DATA_DIR":/data \
  "$IMAGE" >/dev/null

# Container beim Beenden (auch per Strg+C) wieder aufraeumen.
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT

echo "Warte auf Apache..."
for _ in $(seq 1 30); do
  if curl -fs -o /dev/null "http://localhost:$PORT/"; then break; fi
  sleep 1
done

# Videos laufen seit kurzem direkt ueber das /media-Alias des Webservers,
# nicht mehr durch PHP - das muss also stehen, und darf nur Video-Endungen
# freigeben. Der Ordner ist hier leer, es geht nur um die Zugriffsregeln.
echo
echo "== /media-Alias (Apache, kein PHP) =="
code=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/media/x/does-not-exist.mp4")
echo "Video-Endung  -> $code (404 erwartet: Alias steht, Datei fehlt einfach)"
code=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/media/x/room.sqlite")
echo "andere Endung -> $code (403 erwartet: gesperrt)"

echo
echo "Laeuft auf http://localhost:$PORT - Strg+C beendet und entfernt den Container."
echo "Daten (auch fuer /media) liegen in $DATA_DIR."
docker logs -f "$NAME"
