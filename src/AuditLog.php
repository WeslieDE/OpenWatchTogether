<?php
/**
 * Protokoll aus rechtlichen Gruenden: wer wann welches Video hochgeladen
 * oder eine Bildschirmuebertragung gestartet hat. Anders als die Datenbank
 * je Raum (Db.php) liegt das hier zentral fuer alle Raeume in einer eigenen
 * Datei, und ueberlebt auch das Aufraeumen der Raeume beim Neustart.
 *
 * Eintraege, die aelter als sechs Monate sind, holt purgeOld() weg - das
 * geschieht beim Start des Containers, siehe Cleanup::wipe().
 */
declare(strict_types=1);

namespace tk\weslie\WatchTogether;

use PDO;

final class AuditLog
{
    private const RETENTION = '-6 months';

    private static ?PDO $pdo = null;

    private static function pdo(): PDO
    {
        if (self::$pdo !== null) {
            return self::$pdo;
        }
        $dir  = (string)Config::get('dataDir');
        $path = $dir . '/audit.sqlite';
        Files::ensureDir($dir);

        $pdo = new PDO('sqlite:' . $path, null, null, [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        ]);
        $pdo->exec('PRAGMA journal_mode = WAL');
        $pdo->exec('PRAGMA busy_timeout = 5000');
        $pdo->exec(
            'CREATE TABLE IF NOT EXISTS uploads (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                room      TEXT NOT NULL,
                file_name TEXT NOT NULL,
                username  TEXT NOT NULL,
                ip        TEXT NOT NULL,
                created   INTEGER NOT NULL
            )'
        );
        $pdo->exec(
            'CREATE TABLE IF NOT EXISTS streams (
                id       INTEGER PRIMARY KEY AUTOINCREMENT,
                room     TEXT NOT NULL,
                username TEXT NOT NULL,
                ip       TEXT NOT NULL,
                started  INTEGER NOT NULL,
                ended    INTEGER,
                duration INTEGER
            )'
        );

        /* Apache (Upload) und der getrennt laufende WebSocket-Prozess
           (Live-Start) schreiben hier gemeinsam hinein - siehe Files::share(). */
        Files::share($path);
        Files::share($path . '-wal');
        Files::share($path . '-shm');

        return self::$pdo = $pdo;
    }

    /** Ein Video ist fertig hochgeladen und liegt in der Warteschlange. */
    public static function logUpload(string $room, string $fileName, string $username, string $ip): void
    {
        $q = self::pdo()->prepare(
            'INSERT INTO uploads (room, file_name, username, ip, created)
             VALUES (:room, :file, :user, :ip, :created)'
        );
        $q->execute([
            ':room'    => $room,
            ':file'    => $fileName,
            ':user'    => $username,
            ':ip'      => $ip,
            ':created' => \time(),
        ]);
    }

    /** Eine Bildschirmuebertragung faengt an. Die Id nimmt streamEnd() wieder entgegen. */
    public static function streamStart(string $room, string $username, string $ip): int
    {
        $q = self::pdo()->prepare(
            'INSERT INTO streams (room, username, ip, started)
             VALUES (:room, :user, :ip, :started)'
        );
        $q->execute([
            ':room'    => $room,
            ':user'    => $username,
            ':ip'      => $ip,
            ':started' => \time(),
        ]);
        return (int)self::pdo()->lastInsertId();
    }

    /** Vorbei - die Laufzeit wird aus dem festgehaltenen Anfang errechnet. */
    public static function streamEnd(int $id): void
    {
        $now = \time();
        self::pdo()->prepare(
            'UPDATE streams SET ended = :ended, duration = :ended - started WHERE id = :id'
        )->execute([':ended' => $now, ':id' => $id]);
    }

    /** Alles weg, was laenger als sechs Monate zurueckliegt. */
    public static function purgeOld(): void
    {
        $cutoff = (int)\strtotime(self::RETENTION);
        $pdo = self::pdo();
        $pdo->prepare('DELETE FROM uploads WHERE created < ?')->execute([$cutoff]);
        $pdo->prepare('DELETE FROM streams WHERE COALESCE(ended, started) < ?')->execute([$cutoff]);
    }
}
