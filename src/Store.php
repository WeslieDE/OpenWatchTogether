<?php
/**
 * Ablage der Videos und die Uebertragung dorthin.
 *
 * Der Browser schickt die Datei in Stuecken. Jedes Stueck wird hinten an eine
 * Teildatei gehaengt. Das kommt ohne grosse Werte in der php.ini aus, macht
 * den Fortschritt genau und laesst sich jederzeit abbrechen.
 *
 * Ist alles da, bekommt die Datei einen zufaelligen eindeutigen Namen, ffmpeg
 * ermittelt Laufzeit und Vorschaubild, und der Eintrag wandert in die
 * Datenbank des Raumes.
 */
declare(strict_types=1);

namespace tk\weslie\WatchTogether;

final class Store
{
    /** Uebertragung anmelden. Gibt die Kennung fuer die weiteren Aufrufe. */
    public static function begin(string $slug, string $fileName, int $size): array
    {
        if (!Files::playable($fileName)) {
            throw new ApiError('format', 'Dieses Format spielt der Browser nicht direkt ab.');
        }
        if ($size <= 0) {
            throw new ApiError('size', 'Die Datei ist leer.');
        }
        /* Ohne Obergrenze ist maxBytes 0. Dann geht jede Groesse durch. */
        $max = (int)Config::get('maxBytes');
        if ($max > 0 && $size > $max) {
            throw new ApiError('size', 'Die Datei ist zu gross.');
        }

        $dir = Rooms::ensure($slug) . '/parts';
        Files::ensureDir($dir);

        $uid = \bin2hex(\random_bytes(12));
        \file_put_contents($dir . '/' . $uid . '.json', (string)\json_encode([
            'name'    => \substr($fileName, -180),
            'size'    => $size,
            'created' => \time(),
        ]));
        \file_put_contents($dir . '/' . $uid . '.part', '');

        return ['id' => $uid, 'chunk' => (int)Config::get('chunkBytes')];
    }

    /**
     * Ein Stueck anhaengen. Der Versatz muss zur bisherigen Laenge passen,
     * sonst ist unterwegs etwas verloren gegangen.
     *
     * @param resource $input
     */
    public static function append(string $slug, string $uid, $input, int $offset): array
    {
        [$part, $meta] = self::session($slug, $uid);

        $have = (int)\filesize($part);
        if ($offset !== $have) {
            throw new ApiError('offset', 'Der Versatz passt nicht: erwartet ' . $have . '.');
        }

        $fh = \fopen($part, 'ab');
        if ($fh === false) {
            throw new ApiError('io', 'Teildatei nicht beschreibbar.');
        }

        $written = 0;
        while (!\feof($input)) {
            $chunk = \fread($input, 262144);
            if ($chunk === false || $chunk === '') {
                break;
            }
            if ($have + $written + \strlen($chunk) > $meta['size']) {
                \fclose($fh);
                throw new ApiError('size', 'Es kam mehr an als angekuendigt.');
            }
            \fwrite($fh, $chunk);
            $written += \strlen($chunk);
        }
        \fclose($fh);

        Rooms::touch($slug);
        return ['received' => $have + $written, 'size' => $meta['size']];
    }

    /**
     * Uebertragung abschliessen. durationHint und posterData kommen aus dem
     * Browser und springen nur ein, wenn ffmpeg fehlt.
     */
    public static function finish(
        string $slug,
        string $uid,
        string $title,
        string $by,
        ?string $byId,
        float $durationHint = 0.0,
        ?string $posterData = null
    ): array {
        [$part, $meta] = self::session($slug, $uid);

        $size = (int)\filesize($part);
        if ($size !== (int)$meta['size']) {
            throw new ApiError('incomplete', 'Die Uebertragung ist unvollstaendig.');
        }

        $dir  = Rooms::dir($slug);
        $ext  = Files::extensionOf($meta['name']);
        $id   = \bin2hex(\random_bytes(16));
        $file = $id . ($ext === '' ? '' : '.' . $ext);

        if (!@\rename($part, $dir . '/' . $file)) {
            throw new ApiError('io', 'Datei laesst sich nicht ablegen.');
        }
        @\unlink(self::metaPath($slug, $uid));

        /* Laufzeit und Vorschaubild, so wie es die Planung vorsieht. */
        $path     = $dir . '/' . $file;
        $duration = Probe::duration($path);
        if ($duration <= 0) {
            $duration = \max(0.0, $durationHint);
        }

        $posterName = $id . '.jpg';
        $posterPath = $dir . '/' . $posterName;
        /* Ohne Laufzeit wird das erste Bild genommen, damit auch dann noch ein
           Versuch stattfindet. */
        $hasPoster = Probe::available() && Probe::poster($path, $posterPath, $duration);
        if (!$hasPoster && $posterData !== null) {
            $hasPoster = Probe::posterFromData($posterData, $posterPath);
        }

        /* Weder eine Laufzeit noch ein einziges Bild: das ist kein Video, das
           sich abspielen laesst. Die Datei kommt weg, ein Eintrag entsteht gar
           nicht erst, und der Browser nimmt ihn aus der Warteschlange. */
        if ($duration <= 0 && !$hasPoster) {
            @\unlink($path);
            @\unlink($posterPath);
            throw new ApiError('invalid', 'Diese Datei laesst sich nicht abspielen.', 422);
        }

        $db = Db::of($slug);
        $db->add([
            'id'        => $id,
            'file'      => $file,
            'poster'    => $hasPoster ? $posterName : null,
            'title'     => self::title($title, $meta['name']),
            'addedBy'   => $by,
            'addedById' => $byId,
            'duration'  => $duration,
            'bytes'     => $size,
            'mime'      => Files::mimeOf($file),
        ]);
        Rooms::touch($slug);

        $row = $db->row($id);
        return $row === null ? [] : Db::toItem($slug, $row);
    }

    /** Abbruch. Die Teildatei verschwindet, der Eintrag in der Liste auch. */
    public static function abort(string $slug, string $uid): void
    {
        if (!self::valid($uid)) {
            return;
        }
        $dir = Rooms::dir($slug) . '/parts';
        @\unlink($dir . '/' . $uid . '.part');
        @\unlink($dir . '/' . $uid . '.json');
    }

    /** @return array{0:string,1:array{name:string,size:int,created:int}} */
    private static function session(string $slug, string $uid): array
    {
        if (!self::valid($uid)) {
            throw new ApiError('unknown', 'Unbekannte Uebertragung.');
        }
        $part = Rooms::dir($slug) . '/parts/' . $uid . '.part';
        $json = self::metaPath($slug, $uid);
        if (!\is_file($part) || !\is_file($json)) {
            throw new ApiError('unknown', 'Unbekannte Uebertragung.');
        }
        $meta = \json_decode((string)\file_get_contents($json), true);
        if (!\is_array($meta)) {
            throw new ApiError('unknown', 'Unbekannte Uebertragung.');
        }
        $meta['size'] = (int)$meta['size'];
        $meta['name'] = (string)$meta['name'];
        return [$part, $meta];
    }

    private static function metaPath(string $slug, string $uid): string
    {
        return Rooms::dir($slug) . '/parts/' . $uid . '.json';
    }

    private static function valid(string $uid): bool
    {
        return \preg_match('/^[0-9a-f]{24}$/', $uid) === 1;
    }

    private static function title(string $title, string $fileName): string
    {
        $title = \trim(\preg_replace('/\s+/u', ' ', $title) ?? '');
        return $title === ''
            ? Files::titleOf($fileName)
            : \mb_substr($title, 0, 120, 'UTF-8');
    }
}
