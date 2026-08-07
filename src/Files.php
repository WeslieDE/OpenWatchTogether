<?php
/**
 * Kleine Helfer rund um Dateien.
 */
declare(strict_types=1);

namespace tk\weslie\WatchTogether;

final class Files
{
    public static function ensureDir(string $dir): void
    {
        if (!\is_dir($dir) && !@\mkdir($dir, 0775, true) && !\is_dir($dir)) {
            throw new \RuntimeException('Ordner nicht anlegbar: ' . $dir);
        }
    }

    public static function removeTree(string $dir): void
    {
        if (!\is_dir($dir)) {
            return;
        }
        $items = @\scandir($dir);
        if ($items === false) {
            return;
        }
        foreach ($items as $item) {
            if ($item === '.' || $item === '..') {
                continue;
            }
            $path = $dir . '/' . $item;
            if (\is_dir($path) && !\is_link($path)) {
                self::removeTree($path);
            } else {
                @\unlink($path);
            }
        }
        @\rmdir($dir);
    }

    /** Zufaelliger, eindeutiger Name. Die Endung bleibt, damit der Typ stimmt. */
    public static function randomName(string $ext): string
    {
        $ext = \strtolower(\preg_replace('/[^a-z0-9]/i', '', $ext) ?? '');
        $name = \bin2hex(\random_bytes(16));
        return $ext === '' ? $name : $name . '.' . $ext;
    }

    /** Nur Endungen, die der Browser ohne Umwandlung abspielt. */
    private const TYPES = [
        'mp4'  => 'video/mp4',
        'm4v'  => 'video/mp4',
        'webm' => 'video/webm',
        'ogv'  => 'video/ogg',
        'ogg'  => 'video/ogg',
        'mov'  => 'video/quicktime',
    ];

    public static function extensionOf(string $fileName): string
    {
        $ext = \strtolower((string)\pathinfo($fileName, \PATHINFO_EXTENSION));
        return \preg_replace('/[^a-z0-9]/', '', $ext) ?? '';
    }

    public static function playable(string $fileName): bool
    {
        return isset(self::TYPES[self::extensionOf($fileName)]);
    }

    public static function mimeOf(string $fileName): string
    {
        return self::TYPES[self::extensionOf($fileName)] ?? 'application/octet-stream';
    }

    /** Aus einem Dateinamen einen lesbaren Titel machen. */
    public static function titleOf(string $fileName): string
    {
        $base  = (string)\pathinfo($fileName, \PATHINFO_FILENAME);
        $title = \trim((string)\preg_replace('/[-_]+/', ' ', $base));
        return \mb_substr($title === '' ? $fileName : $title, 0, 120, 'UTF-8');
    }
}
