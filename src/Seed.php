<?php
/**
 * Vorrat fuer leere Raeume.
 *
 * Liegt unter default/<Raum>/ etwas, bekommt ein Raum das beim ersten Betreten
 * in seine Warteschlange gelegt: die Datei wandert in den Raumordner, ffmpeg
 * ermittelt Laufzeit und Vorschaubild, der Eintrag geht in die Datenbank des
 * Raumes. Danach ist es ein Video wie jedes andere und laesst sich auch wieder
 * herauswerfen.
 *
 * Der Ordner darf den Raumnamen tragen oder dessen Kennung. Der Vorrat selbst
 * bleibt unangetastet: der Raum bekommt eine eigene Datei, moeglichst als
 * harte Verknuepfung, sonst als Kopie.
 */
declare(strict_types=1);

namespace tk\weslie\WatchTogether;

final class Seed
{
    /**
     * Legt den Vorrat in den Raum, sofern dort noch nichts liegt. Gibt zurueck,
     * wie viele Videos dazugekommen sind.
     */
    public static function into(string $slug): int
    {
        if (!Config::get('seed')) {
            return 0;
        }

        $from = self::folder($slug);
        if ($from === null) {
            return 0;
        }

        $db = Db::of($slug);
        if ($db->count() > 0) {
            return 0;      /* im Raum liegt schon etwas */
        }

        $dir   = Rooms::ensure($slug);
        $added = 0;
        foreach (self::files($from) as $path) {
            if (self::one($db, $dir, $path)) {
                $added++;
            }
        }
        if ($added > 0) {
            Rooms::touch($slug);
        }
        return $added;
    }

    /** default/<Raumname>/ oder default/<Kennung>/, was zuerst da ist. */
    private static function folder(string $slug): ?string
    {
        $base = \rtrim((string)Config::get('defaultDir'), '/');
        if ($base === '' || $slug === '') {
            return null;
        }
        foreach ([$slug, Rooms::id($slug)] as $name) {
            if (\is_dir($base . '/' . $name)) {
                return $base . '/' . $name;
            }
        }
        return null;
    }

    /** @return list<string> Abspielbare Dateien, in der Reihenfolge des Namens. */
    private static function files(string $dir): array
    {
        $names = @\scandir($dir);
        if ($names === false) {
            return [];
        }

        $out = [];
        foreach ($names as $name) {
            $path = $dir . '/' . $name;
            if ($name === '.' || $name === '..' || !\is_file($path)) {
                continue;
            }
            if (!Files::playable($name) || (int)@\filesize($path) <= 0) {
                continue;
            }
            $out[] = $path;
        }
        \sort($out, \SORT_NATURAL | \SORT_FLAG_CASE);
        return $out;
    }

    /** Ein Video aus dem Vorrat in den Raum. */
    private static function one(Db $db, string $dir, string $path): bool
    {
        $ext  = Files::extensionOf($path);
        $id   = \bin2hex(\random_bytes(16));
        $file = $id . ($ext === '' ? '' : '.' . $ext);
        $dest = $dir . '/' . $file;

        if (!self::place($path, $dest)) {
            \error_log('[WatchTogether] Vorrat nicht uebernehmbar: ' . $path);
            return false;
        }

        /* Laufzeit und Vorschaubild wie nach einem Upload. Ohne ffmpeg bleibt
           beides leer; die Laufzeit liest dann der Browser aus dem Video. */
        $duration   = Probe::duration($dest);
        $posterName = $id . '.jpg';
        $hasPoster  = $duration > 0 && Probe::poster($dest, $dir . '/' . $posterName, $duration);

        $db->add([
            'id'        => $id,
            'file'      => $file,
            'poster'    => $hasPoster ? $posterName : null,
            'title'     => Files::titleOf(\basename($path)),
            /* Niemand hat es mitgebracht, es lag schon im Raum. */
            'addedBy'   => 'Vorrat',
            'addedById' => null,
            'duration'  => $duration,
            'bytes'     => (int)@\filesize($dest),
            'mime'      => Files::mimeOf($file),
        ]);
        return true;
    }

    /**
     * Die Datei in den Raum bringen. Eine harte Verknuepfung kostet nichts und
     * belegt den Platz kein zweites Mal; sie verhaelt sich sonst wie eine
     * Kopie, auch beim Loeschen im Raum. Geht sie nicht, wird kopiert.
     */
    private static function place(string $from, string $to): bool
    {
        if (@\link($from, $to)) {
            return true;
        }
        if (@\copy($from, $to)) {
            return true;
        }
        @\unlink($to);
        return false;
    }
}
