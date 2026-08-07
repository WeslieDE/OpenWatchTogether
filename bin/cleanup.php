<?php
/**
 * Aufraeumen von Hand oder aus einem Zeitplan heraus.
 *
 *   php bin/cleanup.php          liegengebliebene Teildateien loeschen
 *   php bin/cleanup.php --wipe   alles loeschen, wie beim Start des Containers
 */
declare(strict_types=1);

require __DIR__ . '/../vendor/autoload.php';

use tk\weslie\WatchTogether\Cleanup;
use tk\weslie\WatchTogether\Config;

if (\in_array('--wipe', $argv, true)) {
    Cleanup::wipe();
    echo 'Alles geloescht unter ' . Config::get('mediaDir') . \PHP_EOL;
    exit(0);
}

$stat = Cleanup::run();
echo \sprintf("Angefangene Uebertragungen: %d\n", $stat['parts']);
