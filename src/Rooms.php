<?php
/**
 * Raeume. Der Raumname aus der Adresszeile wird zu einer Kennung verkuerzt,
 * die als Ordnername dient. Unter dem Ordner liegen die Videos, die
 * Vorschaubilder und die Datenbank des Raumes.
 */
declare(strict_types=1);

namespace tk\weslie\WatchTogether;

final class Rooms
{
    /** Muss zu slugify() im Browser passen. */
    public static function normalize(string $name): string
    {
        $name = \mb_strtolower(\trim($name), 'UTF-8');
        $name = \preg_replace('/\s+/u', '-', $name) ?? '';
        $name = \preg_replace('/[^a-z0-9äöüß\-]/u', '', $name) ?? '';
        $name = \preg_replace('/-+/', '-', $name) ?? '';
        $name = \trim($name, '-');
        return \mb_substr($name, 0, 40, 'UTF-8');
    }

    /** Kennung des Raumes: Hash des Namens, nur Hex, taugt als Ordnername. */
    public static function id(string $slug): string
    {
        return \substr(\hash('sha256', 'watch-together:' . $slug), 0, 20);
    }

    public static function dir(string $slug): string
    {
        return Config::get('mediaDir') . '/' . self::id($slug);
    }

    public static function exists(string $slug): bool
    {
        return \is_dir(self::dir($slug));
    }

    /** Legt den Raumordner an, falls er noch nicht da ist. */
    public static function ensure(string $slug): string
    {
        $dir = self::dir($slug);
        if (!\is_dir($dir)) {
            if (!@\mkdir($dir, 0775, true) && !\is_dir($dir)) {
                throw new \RuntimeException('Raumordner nicht anlegbar: ' . $dir);
            }
            @\mkdir($dir . '/parts', 0775, true);
            /* Der Klarname steht nur hier, sonst arbeitet alles mit der Kennung. */
            @\file_put_contents($dir . '/room.txt', $slug);
        }
        return $dir;
    }

    /**
     * Der Klarname zu einem Raumordner. Nur gueltig, wenn der Ordner auch
     * wirklich zu diesem Namen gehoert - sonst ist dort etwas anderes gelandet.
     */
    public static function slugOf(string $dir): ?string
    {
        $file = $dir . '/room.txt';
        if (!\is_file($file)) {
            return null;
        }
        $slug = self::normalize((string)@\file_get_contents($file));
        if ($slug === '' || self::id($slug) !== \basename($dir)) {
            return null;
        }
        return $slug;
    }

    /** Haelt fest, dass im Raum etwas los war. */
    public static function touch(string $slug): void
    {
        $dir = self::dir($slug);
        if (\is_dir($dir)) {
            @\touch($dir . '/room.txt');
        }
    }

    /** Wann war im Raum zuletzt etwas los? */
    public static function seen(string $slug): int
    {
        $file = self::dir($slug) . '/room.txt';
        $at = \is_file($file) ? @\filemtime($file) : false;
        return $at === false ? 0 : $at;
    }

    /** Gibt zurueck, ob der Raum danach wirklich weg ist. */
    public static function remove(string $slug): bool
    {
        $dir = self::dir($slug);
        Files::removeTree($dir);
        return !\is_dir($dir);
    }
}
