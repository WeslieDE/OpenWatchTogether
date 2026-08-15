# Watch Together. Ein Bild, drei Prozesse: Apache mit der API, daneben der
# langlaufende Prozess fuer die Live-Verbindung und der SFU-Prozess fuer die
# Bildschirmuebertragung (WebRTC/mediasoup, Node.js).
#
# Zustandslos. Alles Gespeicherte liegt unter /data und wird beim Start
# verworfen. Ein Volume ist ausdruecklich nicht noetig - erst wenn Raeume ihre
# Videos ueber den Container hinaus behalten sollen, lohnt eines.

FROM php:8.3-apache

# ffmpeg fuer Laufzeit und Vorschaubild, supervisor haelt alle drei Prozesse
# am Leben. In der Entwicklung unter Windows liegt ffmpeg stattdessen
# portabel im Projektordner unter tools/.
#
# unzip braucht Composer, um Pakete auszupacken. Das Grundabbild bringt weder
# das Programm noch die Zip-Erweiterung mit.
#
# Node.js kommt ueber das offizielle NodeSource-Repo dazu - das Grundabbild
# bringt keins mit. mediasoup laedt beim npm-Install ein fertiges Worker-
# Binary fuer Linux/x64 herunter, ein Compiler ist dafuer nicht noetig.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ffmpeg supervisor unzip ca-certificates curl gnupg; \
    mkdir -p /etc/apt/keyrings; \
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg; \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" > /etc/apt/sources.list.d/nodesource.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends nodejs; \
    rm -rf /var/lib/apt/lists/*; \
    docker-php-ext-install pcntl; \
    a2enmod proxy proxy_wstunnel; \
    php -r 'exit(extension_loaded("pdo_sqlite") ? 0 : 1);'

# Die Live-Verbindung laeuft ueber denselben Port wie die Seite.
COPY docker/watch-together.conf /etc/apache2/conf-available/watch-together.conf
RUN a2enconf watch-together

COPY docker/php.ini /usr/local/etc/php/conf.d/watch-together.ini
COPY docker/supervisord.conf /etc/supervisor/conf.d/watch-together.conf
COPY docker/entrypoint.sh /usr/local/bin/entrypoint
# Zeilenenden glaetten, falls die Datei ueber Windows gereist ist.
RUN sed -i 's/\r$//' /usr/local/bin/entrypoint && chmod +x /usr/local/bin/entrypoint

WORKDIR /var/www/html

COPY --from=composer:2 /usr/bin/composer /usr/bin/composer
COPY composer.json composer.lock ./
RUN composer install --no-dev --no-interaction --optimize-autoloader --no-scripts \
    && rm -f /usr/bin/composer

COPY sfu/package.json sfu/package-lock.json ./sfu/
RUN cd sfu && npm ci --omit=dev

COPY . .

ENV WT_DATA_DIR=/data \
    WT_WS_HOST=127.0.0.1 \
    WT_WS_PORT=8081 \
    WT_WS_URL=/ws \
    WT_SFU_WS_HOST=127.0.0.1 \
    WT_SFU_WS_PORT=8082 \
    WT_SFU_WS_URL=/sfu-ws \
    WT_SFU_LISTEN_IP=0.0.0.0 \
    WT_SFU_PORT=42000

RUN mkdir -p /data && chown -R www-data:www-data /data /var/www/html

# 80/443 fuer die Seite samt beider Signalisierungen (per Reverse-Proxy), der
# SFU-Medienport zusaetzlich direkt - UDP und TCP teilen sich denselben Port
# (mediasoup WebRtcServer), das ist der einzige weitere offene Port. Ohne
# eigenen TURN-Server muss er von aussen erreichbar sein; WT_SFU_ANNOUNCED_IP
# muss auf die oeffentliche Adresse des Hosts zeigen.
EXPOSE 80
EXPOSE 42000/udp
EXPOSE 42000/tcp

ENTRYPOINT ["entrypoint"]
CMD ["supervisord", "-c", "/etc/supervisor/conf.d/watch-together.conf", "-n"]
