<?php
/**
 * Aufraeumen. Raeume und Videos bleiben liegen, solange der Dienst laeuft.
 * Weg sind sie erst beim Neustart, dort verwirft wipe() den Bestand - bis auf
 * die Raeume, die ihre Videos ausdruecklich behalten sollen.
 *
 * Im Betrieb wird nur weggeraeumt, was niemandem gehoert: angefangene
 * Uebertragungen, an denen seit sechs Stunden niemand mehr arbeitet.
 *
 * Laeuft im Hintergrund des WebSocket-Prozesses und nebenbei bei API-Aufrufen,
 * dort hoechstens einmal alle zehn Minuten.
 */
declare(strict_types=1);

namespace tk\weslie\WatchTogether;

final class Cleanup
{
    private const PART_TTL = 6 * 3600;
    private const THROTTLE = 600;

    /** Nebenbei, gedrosselt. Kostet die meiste Zeit gar nichts. */
    public static function maybe(): void
    {
        $marker = Config::get('dataDir') . '/.cleanup';
        $last = \is_file($marker) ? (int)@\filemtime($marker) : 0;
        if (\time() - $last < self::THROTTLE) {
            return;
        }
        Files::ensureDir((string)Config::get('dataDir'));
        @\touch($marker);
        self::run();
    }

    /**
     * Liegengebliebene Teildateien einsammeln. Raeume und Videos bleiben
     * unberuehrt.
     *
     * @return array{parts:int}
     */
    public static function run(): array
    {
        $media = (string)Config::get('mediaDir');
        $now   = \time();
        $stat  = ['parts' => 0];

        if (!\is_dir($media)) {
            return $stat;
        }

        foreach (@\scandir($media) ?: [] as $entry) {
            if ($entry === '.' || $entry === '..') {
                continue;
            }
            $dir = $media . '/' . $entry;
            if (\is_dir($dir)) {
                $stat['parts'] += self::sweepParts($dir, $now);
            }
        }

        return $stat;
    }

    /**
     * Alles loeschen. Wird beim Start des Containers aufgerufen.
     *
     * Ausgenommen sind Raeume, in denen die Videos ausdruecklich liegen
     * bleiben sollen und in denen auch noch welche liegen. Sie ueberstehen den
     * Neustart; nur die angefangenen Uebertragungen darin gehen weg, denn zu
     * denen gehoert kein Browser mehr.
     */
    public static function wipe(): void
    {
        $media = (string)Config::get('mediaDir');
        Files::ensureDir($media);

        foreach (@\scandir($media) ?: [] as $entry) {
            if ($entry === '.' || $entry === '..') {
                continue;
            }
            $dir = $media . '/' . $entry;
            if (!\is_dir($dir)) {
                @\unlink($dir);
                continue;
            }
            if (self::kept($dir)) {
                self::wipeParts($dir);
                continue;
            }
            Files::removeTree($dir);
        }
    }

    /** Soll dieser Raumordner den Neustart ueberleben? */
    private static function kept(string $dir): bool
    {
        $slug = Rooms::slugOf($dir);
        if ($slug === null) {
            return false;
        }
        try {
            return Db::keeps($slug);
        } catch (\Throwable $e) {
            /* Ohne lesbare Datenbank gibt es nichts zu bewahren. */
            return false;
        }
    }

    private static function wipeParts(string $dir): void
    {
        Files::removeTree($dir . '/parts');
        Files::ensureDir($dir . '/parts');
    }

    private static function sweepParts(string $dir, int $now): int
    {
        $parts = $dir . '/parts';
        if (!\is_dir($parts)) {
            return 0;
        }
        $gone = 0;
        foreach (@\scandir($parts) ?: [] as $file) {
            if ($file === '.' || $file === '..') {
                continue;
            }
            $path = $parts . '/' . $file;
            if (\is_file($path) && $now - (int)@\filemtime($path) > self::PART_TTL) {
                @\unlink($path);
                $gone++;
            }
        }
        return $gone;
    }
}
