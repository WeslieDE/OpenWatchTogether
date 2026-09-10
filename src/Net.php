<?php
/**
 * Die IP eines Teilnehmers herausfinden - fuer das Protokoll der Uploads und
 * Uebertragungen (siehe AuditLog), nicht fuer Zugriffsentscheidungen.
 *
 * Ueber HTTP kommt sie direkt von Apache. Die Live-Verbindung laeuft dagegen
 * ueber den in watch-together.conf durchgereichten WebSocket-Proxy, dort
 * steht die eigentliche Adresse in X-Forwarded-For statt in der Verbindung
 * selbst - die zeigt sonst nur auf Apache (127.0.0.1).
 */
declare(strict_types=1);

namespace tk\weslie\WatchTogether;

final class Net
{
    /** Adresse des HTTP-Aufrufers. */
    public static function httpIp(): string
    {
        $forwarded = (string)($_SERVER['HTTP_X_FORWARDED_FOR'] ?? '');
        $ip = self::firstValid($forwarded);
        if ($ip !== null) {
            return $ip;
        }
        return (string)($_SERVER['REMOTE_ADDR'] ?? '');
    }

    /**
     * Adresse aus dem rohen Header des WebSocket-Handshakes, mit der
     * tatsaechlichen Verbindung (meist Apache selbst) als Rueckfallwert.
     */
    public static function headerIp(string $rawHeader, string $fallback): string
    {
        if (\preg_match('/^X-Forwarded-For:\s*(.+)$/mi', $rawHeader, $m) === 1) {
            $ip = self::firstValid($m[1]);
            if ($ip !== null) {
                return $ip;
            }
        }
        return $fallback;
    }

    /** Erste gueltige Adresse einer kommagetrennten Liste. */
    private static function firstValid(string $list): ?string
    {
        foreach (\explode(',', $list) as $part) {
            $ip = \trim($part);
            if ($ip !== '' && \filter_var($ip, \FILTER_VALIDATE_IP) !== false) {
                return $ip;
            }
        }
        return null;
    }
}
