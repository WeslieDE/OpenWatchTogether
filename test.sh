#!/usr/bin/env bash
# Baut das Image und startet es lokal zum Testen - inklusive SFU-Port fuer
# die Bildschirmuebertragung. "docker" laesst sich 1:1 durch "podman"
# ersetzen, beide verstehen dieselben Argumente.
set -euo pipefail

IMAGE=weslie/watchtogether
NAME=watchtogether-test

docker build -t "$IMAGE" .

docker rm -f "$NAME" >/dev/null 2>&1 || true

docker run --rm --name "$NAME" \
  -p 8889:80 \
  -p 42000:42000/tcp \
  -p 42000:42000/udp \
  -e WT_SFU_ANNOUNCED_IP=127.0.0.1 \
  "$IMAGE"
