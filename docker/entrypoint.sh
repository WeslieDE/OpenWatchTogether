#!/bin/sh
# Beim Start wird alles verworfen. Das System ist zustandslos, ein Volume ist
# nicht vorgesehen.
set -e

DATA="${WT_DATA_DIR:-/data}"
mkdir -p "$DATA"
php /var/www/html/bin/cleanup.php --wipe >/dev/null 2>&1 || true
chown -R www-data:www-data "$DATA"

exec "$@"
