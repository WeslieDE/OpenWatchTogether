<?php
/**
 * Die API. Gewoehnliches PHP, angesprochen per AJAX aus dem Browser.
 *
 *   do=config          Was der Browser wissen muss, bevor es losgeht
 *   do=room            Raum betreten oder anlegen, liefert die Warteschlange
 *   do=queue           Warteschlange des Raumes
 *   do=upload-begin    Uebertragung anmelden
 *   do=upload-chunk    ein Stueck der Datei anhaengen
 *   do=upload-finish   fertig: umbenennen, Laufzeit, Vorschaubild, eintragen
 *   do=upload-abort    Uebertragung wegwerfen
 *   do=remove          Video aus der Warteschlange loeschen, samt Datei
 *   do=media           Video ausliefern, mit Unterstuetzung fuer Sprungmarken
 *   do=poster          Vorschaubild ausliefern
 */
declare(strict_types=1);

namespace tk\weslie\WatchTogether;

final class Api
{
    public static function handle(): void
    {
        $do = (string)($_GET['do'] ?? '');

        try {
            Files::ensureDir((string)Config::get('mediaDir'));

            switch ($do) {
                case 'config':        self::config();      break;
                case 'room':          self::room();        break;
                case 'queue':         self::queue();       break;
                case 'upload-begin':  self::uploadBegin(); break;
                case 'upload-chunk':  self::uploadChunk(); break;
                case 'upload-finish': self::uploadFinish();break;
                case 'upload-abort':  self::uploadAbort(); break;
                case 'remove':        self::remove();      break;
                case 'media':         self::media(false);  break;
                case 'poster':        self::media(true);   break;
                default:
                    throw new ApiError('unknown', 'Unbekannter Aufruf.', 404);
            }
        } catch (ApiError $e) {
            self::json(['ok' => false, 'reason' => $e->reason, 'error' => $e->getMessage()], $e->status);
        } catch (\Throwable $e) {
            \error_log('[WatchTogether] ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
            self::json(['ok' => false, 'reason' => 'server', 'error' => 'Da ist etwas schiefgegangen.'], 500);
        }

        Cleanup::maybe();
    }

    /* ------------------------------------------------------------ Aufrufe -- */

    private static function config(): void
    {
        self::json([
            'ok'         => true,
            'ws'         => [
                'url'  => (string)Config::get('wsUrl'),
                'port' => (int)Config::get('wsPort'),
            ],
            'maxBytes'   => (int)Config::get('maxBytes'),
            'chunkBytes' => (int)Config::get('chunkBytes'),
            /* Fehlt ffmpeg, steuert der Browser Laufzeit und Bild selbst bei. */
            'needsPoster' => !Probe::available(),
        ]);
    }

    private static function room(): void
    {
        $slug = self::slug();
        Rooms::ensure($slug);
        Rooms::touch($slug);
        $db = Db::of($slug);

        self::json([
            'ok'    => true,
            'room'  => $slug,
            'id'    => Rooms::id($slug),
            'queue' => $db->queue(),
            'now'   => $db->meta('now'),
        ]);
    }

    private static function queue(): void
    {
        $slug = self::slug();
        if (!Rooms::exists($slug)) {
            self::json(['ok' => true, 'queue' => [], 'now' => null]);
            return;
        }
        $db = Db::of($slug);
        self::json(['ok' => true, 'queue' => $db->queue(), 'now' => $db->meta('now')]);
    }

    private static function uploadBegin(): void
    {
        $in   = self::body();
        $slug = self::slug();
        Rooms::ensure($slug);

        $started = Store::begin(
            $slug,
            (string)($in['name'] ?? ''),
            (int)($in['size'] ?? 0)
        );

        self::json(['ok' => true] + $started);
    }

    private static function uploadChunk(): void
    {
        $slug = self::slug();
        $uid  = (string)($_GET['id'] ?? '');
        $off  = (int)($_GET['offset'] ?? 0);

        $input = \fopen('php://input', 'rb');
        if ($input === false) {
            throw new ApiError('io', 'Der Datenstrom laesst sich nicht lesen.');
        }
        try {
            $state = Store::append($slug, $uid, $input, $off);
        } finally {
            \fclose($input);
        }

        self::json(['ok' => true] + $state);
    }

    private static function uploadFinish(): void
    {
        $in   = self::body();
        $slug = self::slug();

        $item = Store::finish(
            $slug,
            (string)($in['id'] ?? ''),
            (string)($in['title'] ?? ''),
            self::name((string)($in['by'] ?? '')),
            self::peerId($in['byId'] ?? null),
            (float)($in['duration'] ?? 0),
            isset($in['poster']) && \is_string($in['poster']) ? $in['poster'] : null
        );

        self::json(['ok' => true, 'item' => $item]);
    }

    private static function uploadAbort(): void
    {
        $in = self::body();
        Store::abort(self::slug(), (string)($in['id'] ?? ''));
        self::json(['ok' => true]);
    }

    private static function remove(): void
    {
        $in   = self::body();
        $slug = self::slug();
        $id   = (string)($in['id'] ?? '');

        if (!Rooms::exists($slug)) {
            throw new ApiError('room', 'Diesen Raum gibt es nicht.', 404);
        }
        $gone = Db::of($slug)->remove($id);
        Rooms::touch($slug);

        self::json(['ok' => $gone]);
    }

    /* ------------------------------------------------------- Auslieferung -- */

    private static function media(bool $poster): void
    {
        $slug = self::slug();
        $id   = (string)($_GET['id'] ?? '');
        if (\preg_match('/^[0-9a-f]{32}$/', $id) !== 1) {
            self::plain(404, 'Nicht gefunden.');
        }

        $row = Rooms::exists($slug) ? Db::of($slug)->row($id) : null;
        if ($row === null) {
            self::plain(404, 'Nicht gefunden.');
        }

        $name = $poster ? (string)($row['poster'] ?? '') : (string)$row['file'];
        if ($name === '') {
            self::plain(404, 'Nicht gefunden.');
        }

        $path = Rooms::dir($slug) . '/' . $name;
        if (!\is_file($path)) {
            self::plain(404, 'Nicht gefunden.');
        }

        Rooms::touch($slug);
        self::send($path, $poster ? 'image/jpeg' : (string)$row['mime']);
    }

    /**
     * Datei ausliefern. Bereichsanfragen muessen sein, sonst laesst sich im
     * Video nicht springen.
     */
    private static function send(string $path, string $mime): void
    {
        $size  = (int)\filesize($path);
        $start = 0;
        $end   = $size - 1;
        $range = (string)($_SERVER['HTTP_RANGE'] ?? '');
        $part  = false;

        if ($range !== '' && \preg_match('/^bytes=(\d*)-(\d*)$/', \trim($range), $m) === 1) {
            if ($m[1] === '' && $m[2] === '') {
                self::plain(416, 'Bereich nicht erfuellbar.');
            }
            if ($m[1] === '') {
                $start = \max(0, $size - (int)$m[2]);
            } else {
                $start = (int)$m[1];
                if ($m[2] !== '') {
                    $end = \min($end, (int)$m[2]);
                }
            }
            if ($start > $end || $start >= $size) {
                \header('Content-Range: bytes */' . $size);
                self::plain(416, 'Bereich nicht erfuellbar.');
            }
            $part = true;
        }

        while (\ob_get_level() > 0) {
            \ob_end_clean();
        }

        $length = $end - $start + 1;
        \header('Content-Type: ' . $mime);
        \header('Accept-Ranges: bytes');
        \header('Content-Length: ' . $length);
        \header('Cache-Control: private, max-age=3600');
        if ($part) {
            \http_response_code(206);
            \header('Content-Range: bytes ' . $start . '-' . $end . '/' . $size);
        }

        $fh = \fopen($path, 'rb');
        if ($fh === false) {
            self::plain(500, 'Datei nicht lesbar.');
        }
        \fseek($fh, $start);
        $left = $length;
        while ($left > 0 && !\feof($fh) && !\connection_aborted()) {
            $chunk = \fread($fh, (int)\min(262144, $left));
            if ($chunk === false || $chunk === '') {
                break;
            }
            echo $chunk;
            $left -= \strlen($chunk);
            \flush();
        }
        \fclose($fh);
        exit;
    }

    /* --------------------------------------------------------------- Kram -- */

    private static function slug(): string
    {
        $raw = (string)($_GET['room'] ?? self::body()['room'] ?? '');
        $slug = Rooms::normalize($raw);
        if ($slug === '') {
            throw new ApiError('room', 'Es fehlt der Raum.');
        }
        return $slug;
    }

    private static function name(string $value): string
    {
        $value = \trim(\preg_replace('/\s+/u', ' ', $value) ?? '');
        return $value === '' ? '?' : \mb_substr($value, 0, 24, 'UTF-8');
    }

    private static function peerId(mixed $value): ?string
    {
        $value = \is_string($value) ? $value : '';
        return \preg_match('/^[0-9a-z]{4,32}$/i', $value) === 1 ? $value : null;
    }

    /** @var array<string,mixed>|null */
    private static ?array $body = null;

    /** @return array<string,mixed> */
    private static function body(): array
    {
        if (self::$body !== null) {
            return self::$body;
        }
        $type = (string)($_SERVER['CONTENT_TYPE'] ?? '');
        if (\stripos($type, 'application/json') === false) {
            return self::$body = [];
        }
        $raw = (string)\file_get_contents('php://input');
        $in  = \json_decode($raw, true);
        return self::$body = \is_array($in) ? $in : [];
    }

    private static function json(array $data, int $status = 200): void
    {
        \http_response_code($status);
        \header('Content-Type: application/json; charset=utf-8');
        \header('Cache-Control: no-store');
        echo \json_encode($data, \JSON_UNESCAPED_UNICODE | \JSON_UNESCAPED_SLASHES);
    }

    private static function plain(int $status, string $text): void
    {
        \http_response_code($status);
        \header('Content-Type: text/plain; charset=utf-8');
        echo $text;
        exit;
    }
}
