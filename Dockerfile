# Watch Together. Ein Bild, zwei Prozesse: Apache mit der API und daneben der
# langlaufende Prozess fuer die Live-Verbindung.
#
# Zustandslos. Alles Gespeicherte liegt unter /data und wird beim Start
# verworfen. Ein Volume ist ausdruecklich nicht noetig.

FROM php:8.3-apache

# ffmpeg fuer Laufzeit und Vorschaubild, supervisor haelt beide Prozesse am
# Leben. In der Entwicklung unter Windows liegt ffmpeg stattdessen portabel
# im Projektordner unter tools/.
#
# unzip braucht Composer, um Pakete auszupacken. Das Grundabbild bringt weder
# das Programm noch die Zip-Erweiterung mit.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ffmpeg supervisor unzip; \
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

COPY . .

ENV WT_DATA_DIR=/data \
    WT_WS_HOST=127.0.0.1 \
    WT_WS_PORT=8081 \
    WT_WS_URL=/ws

RUN mkdir -p /data && chown -R www-data:www-data /data /var/www/html

EXPOSE 80

ENTRYPOINT ["entrypoint"]
CMD ["supervisord", "-c", "/etc/supervisor/conf.d/watch-together.conf", "-n"]
