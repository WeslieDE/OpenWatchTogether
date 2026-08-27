<?php
/**
 * Aufraeumen von Hand oder aus einem Zeitplan heraus.
 *
 *   php bin/cleanup.php          liegengebliebene Teildateien loeschen, und
 *                                "behalten"-Raeume, die laenger als
 *                                Cleanup::KEEP_TTL leer stehen
 *   php bin/cleanup.php --wipe   alles loeschen, wie beim Start des Containers.
 *                                Raeume, die ihre Videos behalten sollen, noch
 *                                welche haben und nicht zu lange leer stehen,
 *                                bleiben stehen.
 */
declare(strict_types=1);

require __DIR__ . '/../vendor/autoload.php';

use tk\weslie\WatchTogether\Cleanup;
use tk\weslie\WatchTogether\Config;

if (\in_array('--wipe', $argv, true)) {
    Cleanup::wipe();
    echo 'Aufgeraeumt unter ' . Config::get('mediaDir')
        . ' (Raeume mit behaltenen, nicht zu lange leeren Videos blieben stehen)' . \PHP_EOL;
    exit(0);
}

$stat = Cleanup::run();
echo \sprintf("Angefangene Uebertragungen: %d\n", $stat['parts']);
echo \sprintf("Zu lange leere \"behalten\"-Raeume geloescht: %d\n", $stat['rooms']);
