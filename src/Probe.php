<?php
/**
 * Laufzeit und Vorschaubild. Beides entsteht nach dem Upload mit ffmpeg.
 * Das Bild liegt als JPEG neben dem Video, gleicher Name, Endung .jpg,
 * hoechstens 420p.
 *
 * Ist kein ffmpeg da, bleibt beides leer. Dann traegt der Browser nach, was
 * er selbst aus der Datei lesen konnte.
 */
declare(strict_types=1);

namespace tk\weslie\WatchTogether;

final class Probe
{
    private static ?bool $have = null;

    /**
     * Ist ffmpeg da? Die Antwort wird einen Tag lang gemerkt, sonst starteten
     * bei jedem Seitenaufruf zwei Prozesse nur zur Nachfrage.
     */
    public static function available(): bool
    {
        if (self::$have !== null) {
            return self::$have;
        }

        $marker = Config::get('dataDir') . '/.ffmpeg';
        if (\is_file($marker) && \time() - (int)@\filemtime($marker) < 86400) {
            return self::$have = \trim((string)\file_get_contents($marker)) === '1';
        }

        self::$have = self::works((string)Config::get('ffprobe'))
            && self::works((string)Config::get('ffmpeg'));

        Files::ensureDir((string)Config::get('dataDir'));
        @\file_put_contents($marker, self::$have ? '1' : '0');
        return self::$have;
    }

    /** Laufzeit in Sekunden, 0 wenn sie sich nicht ermitteln laesst. */
    public static function duration(string $file): float
    {
        $out = self::run((string)Config::get('ffprobe'), [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            $file,
        ]);
        if ($out === null) {
            return 0.0;
        }
        $value = (float)\trim($out);
        return $value > 0 && \is_finite($value) ? $value : 0.0;
    }

    /**
     * Standbild bei 20 Prozent der Laufzeit, skaliert auf hoechstens 420p.
     * Gibt true zurueck, wenn ein Bild entstanden ist.
     */
    public static function poster(string $file, string $target, float $duration): bool
    {
        $height = (int)Config::get('posterHeight');
        $at     = \max(0.0, $duration * (float)Config::get('posterAt'));

        $ok = self::run((string)Config::get('ffmpeg'), [
            '-y',
            '-ss', \number_format($at, 3, '.', ''),
            '-i', $file,
            '-frames:v', '1',
            /* Hoehe deckeln, Breite folgt dem Seitenverhaeltnis und bleibt gerade. */
            '-vf', "scale='trunc(oh*a/2)*2':'min(" . $height . ",ih)'",
            '-q:v', '5',
            '-f', 'image2',
            $target,
        ]) !== null;

        if (!$ok || !\is_file($target) || \filesize($target) === 0) {
            @\unlink($target);
            return false;
        }
        return true;
    }

    /** Bild, das der Browser als data:-URL mitgeschickt hat, als Datei ablegen. */
    public static function posterFromData(string $dataUrl, string $target): bool
    {
        if (!\preg_match('#^data:image/(jpeg|jpg|png|webp);base64,#i', $dataUrl, $m)) {
            return false;
        }
        $raw = \base64_decode(\substr($dataUrl, \strlen($m[0])), true);
        if ($raw === false || $raw === '' || \strlen($raw) > 2 * 1024 * 1024) {
            return false;
        }
        return @\file_put_contents($target, $raw) !== false;
    }

    private static function works(string $bin): bool
    {
        return self::run($bin, ['-version']) !== null;
    }

    /** @param list<string> $args */
    private static function run(string $bin, array $args): ?string
    {
        $cmd = [$bin, ...$args];
        $spec = [1 => ['pipe', 'w'], 2 => ['pipe', 'w']];
        $pipes = [];

        /* Ab PHP 7.4 nimmt proc_open ein Array und maskiert selbst korrekt. */
        $proc = @\proc_open($cmd, $spec, $pipes, null, null, ['bypass_shell' => true]);
        if (!\is_resource($proc)) {
            return null;
        }

        /* Beide Kanaele leeren. Wer nur einen liest, haengt sich auf, sobald
           ffmpeg den anderen vollschreibt. */
        $stdout = $pipes[1];
        \stream_set_blocking($pipes[1], false);
        \stream_set_blocking($pipes[2], false);
        $open = [$pipes[1], $pipes[2]];
        $out  = '';

        while ($open !== []) {
            $read = $open;
            $write = $except = null;
            if (@\stream_select($read, $write, $except, 15) === false || $read === []) {
                break;
            }
            foreach ($read as $pipe) {
                $chunk = \fread($pipe, 65536);
                if ($chunk === false || ($chunk === '' && \feof($pipe))) {
                    \fclose($pipe);
                    $open = \array_values(\array_filter(
                        $open,
                        static fn ($p) => \is_resource($p)
                    ));
                    continue;
                }
                if ($pipe === $stdout) {
                    $out .= $chunk;
                }
            }
        }
        foreach ($open as $pipe) {
            if (\is_resource($pipe)) {
                \fclose($pipe);
            }
        }
        $code = \proc_close($proc);

        return $code === 0 ? $out : null;
    }
}
