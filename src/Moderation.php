<?php
/**
 * Prueft Raum- und Anzeigenamen gegen badwords.txt. Zeilen, die mit # anfangen
 * (oder leer sind), zaehlen als Kommentar und bleiben aussen vor.
 *
 * Die Namen werden normalisiert, bevor sie verglichen werden: Kleinschreibung,
 * Umlaute/ss ausgeschrieben, gaengige Leetspeak-Ersetzungen rueckgaengig
 * gemacht, Trennzeichen entfernt. So faellt ein Umgehungsversuch wie
 * "F1ck-Raum" genauso auf wie "fickraum". Kurze/mehrdeutige Eintraege
 * (<= 5 Zeichen) muessen dabei ein eigenes Wort treffen, sonst wuerde etwa
 * "Sauerkraut" am Eintrag "kraut" scheitern.
 */
declare(strict_types=1);

namespace tk\weslie\WatchTogether;

final class Moderation
{
    private const LEET = [
        '0' => 'o', '1' => 'i', '3' => 'e', '4' => 'a',
        '5' => 's', '7' => 't', '@' => 'a', '$' => 's',
    ];

    /** @var list<string>|null */
    private static ?array $words = null;

    public static function violates(string $text): bool
    {
        if ($text === '') {
            return false;
        }
        [$stripped, $tokens] = self::normalize($text);

        foreach (self::words() as $word) {
            if (\mb_strlen($word, 'UTF-8') <= 5) {
                if (\in_array($word, $tokens, true)) {
                    return true;
                }
            } elseif (\str_contains($stripped, $word)) {
                return true;
            }
        }
        return false;
    }

    /**
     * @return array{0:string,1:list<string>} zusammengeklebte und in Woerter
     *   zerlegte Fassung derselben normalisierten Eingabe.
     */
    private static function normalize(string $text): array
    {
        $text = \mb_strtolower($text, 'UTF-8');
        $text = \strtr($text, ['ä' => 'ae', 'ö' => 'oe', 'ü' => 'ue', 'ß' => 'ss']);
        $text = \strtr($text, self::LEET);

        $tokens = \preg_split('/[^a-z0-9]+/u', $text, -1, \PREG_SPLIT_NO_EMPTY) ?: [];
        return [\implode('', $tokens), $tokens];
    }

    /** @return list<string> */
    private static function words(): array
    {
        if (self::$words !== null) {
            return self::$words;
        }

        $words = [];
        $file  = Config::root() . '/badwords.txt';
        $lines = \is_file($file) ? \file($file, \FILE_IGNORE_NEW_LINES) : [];
        foreach ($lines ?: [] as $line) {
            $line = \trim($line);
            if ($line === '' || $line[0] === '#') {
                continue;
            }
            $words[] = $line;
        }

        return self::$words = $words;
    }
}
