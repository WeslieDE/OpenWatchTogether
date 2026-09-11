<?php
/**
 * Optionaler Passwortschutz fuers Hochladen und den Livestream, gesetzt ueber
 * WT_PASSWORD. Ohne dieses Passwort darf das jeder - Zuschauen bleibt in
 * jedem Fall fuer alle offen, hier geht es nur um upload-begin und
 * live-start.
 *
 * Der Browser schickt nie das Passwort selbst, sondern nur dessen SHA-256-
 * Hash (siehe assets/js/app.js, ensureUnlocked). Der Server bildet zum
 * Vergleich denselben Hash aus dem eigenen Passwort - so steht das Passwort
 * nirgends im Browser-Speicher, nur sein Hash.
 */
declare(strict_types=1);

namespace tk\weslie\WatchTogether;

final class Auth
{
    public static function required(): bool
    {
        return (string)Config::get('password') !== '';
    }

    public static function check(string $hash): bool
    {
        $pw = (string)Config::get('password');
        if ($pw === '') {
            return true;
        }
        $hash = \strtolower(\trim($hash));
        if (\preg_match('/^[0-9a-f]{64}$/', $hash) !== 1) {
            return false;
        }
        return \hash_equals(\hash('sha256', $pw), $hash);
    }
}
