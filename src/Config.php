<?php
/**
 * Einstellungen. Alles laesst sich ueber Umgebungsvariablen setzen, damit im
 * Container nichts angefasst werden muss. Ohne Angabe gelten die Vorgaben.
 */
declare(strict_types=1);

namespace tk\weslie\WatchTogether;

final class Config
{
    /** @var array<string,mixed>|null */
    private static ?array $values = null;

    public static function get(string $key): mixed
    {
        if (self::$values === null) {
            self::$values = self::build();
        }
        return self::$values[$key] ?? null;
    }

    public static function set(string $key, mixed $value): void
    {
        if (self::$values === null) {
            self::$values = self::build();
        }
        self::$values[$key] = $value;
    }

    public static function root(): string
    {
        return \dirname(__DIR__);
    }

    /** @return array<string,mixed> */
    private static function build(): array
    {
        $root = self::root();
        $data = self::env('WT_DATA_DIR') ?? self::homeData();

        $values = [
            /* Alles Dauerhafte liegt hier, nie im Projektordner. */
            'dataDir'   => self::clean($data),
            'mediaDir'  => self::clean($data) . '/media',

            /* Verbindung fuer den Browser. Leer heisst: aus der Adresse ableiten. */
            'wsHost'    => self::env('WT_WS_HOST') ?? '0.0.0.0',
            'wsPort'    => (int)(self::env('WT_WS_PORT') ?? 8081),
            'wsUrl'     => self::env('WT_WS_URL') ?? '',

            /* Signalisierung des SFU (mediasoup, eigener Node-Prozess). Gleiches
               Muster wie die Live-Verbindung: leer heisst aus der Adresse
               ableiten, ein Pfad heisst hinter demselben Webserver. */
            'sfuWsPort' => (int)(self::env('WT_SFU_WS_PORT') ?? 8082),
            'sfuWsUrl'  => self::env('WT_SFU_WS_URL') ?? '',

            /* Von Hub.php ausgestellte Tokens fuer den Sender (HMAC), vom
               SFU-Prozess mit demselben Wert geprueft. Leer heisst: wie beim
               Rest der App gibt es keinen Passwortschutz. */
            'sfuSecret' => self::env('WT_SFU_SECRET') ?? '',

            /* Bild und Laufzeit. Leer heisst: der Browser springt ein. */
            'ffmpeg'    => self::env('WT_FFMPEG')  ?? self::bundled('ffmpeg'),
            'ffprobe'   => self::env('WT_FFPROBE') ?? self::bundled('ffprobe'),

            /* Keine Obergrenze je Datei. Wer doch eine will, setzt WT_MAX_BYTES. */
            'maxBytes'   => (int)(self::env('WT_MAX_BYTES') ?? 0),
            'chunkBytes' => (int)(self::env('WT_CHUNK_BYTES') ?? 4 * 1024 * 1024),

            /* Vorschaubild: hoechstens 420p, Standbild bei 20 Prozent Laufzeit. */
            'posterHeight' => 420,
            'posterAt'     => 0.2,
        ];

        $local = $root . '/config.local.php';
        if (\is_file($local)) {
            $extra = require $local;
            if (\is_array($extra)) {
                $values = \array_replace($values, $extra);
            }
        }

        return $values;
    }

    private static function env(string $key): ?string
    {
        $v = \getenv($key);
        return ($v === false || $v === '') ? null : $v;
    }

    /** Vorgabe laut Projektregel: ~/.weslie/WatchTogether */
    private static function homeData(): string
    {
        $home = self::env('HOME') ?? self::env('USERPROFILE');
        if ($home === null) {
            $drive = self::env('HOMEDRIVE');
            $path  = self::env('HOMEPATH');
            $home  = ($drive !== null && $path !== null) ? $drive . $path : \sys_get_temp_dir();
        }
        return $home . '/.weslie/WatchTogether';
    }

    /** Portable Ablage im Projektordner, sonst das, was im PATH liegt. */
    private static function bundled(string $tool): string
    {
        $exe = \DIRECTORY_SEPARATOR === '\\' ? $tool . '.exe' : $tool;
        $own = self::root() . '/tools/ffmpeg/bin/' . $exe;
        return \is_file($own) ? $own : $tool;
    }

    private static function clean(string $path): string
    {
        return \rtrim(\str_replace('\\', '/', $path), '/');
    }
}
