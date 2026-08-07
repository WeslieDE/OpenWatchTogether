<?php
/**
 * Einstieg fuer alle API-Aufrufe. Siehe tk\weslie\WatchTogether\Api.
 */
declare(strict_types=1);

require __DIR__ . '/../vendor/autoload.php';

/* Grosse Dateien kommen in Stuecken, trotzdem soll nichts vorzeitig abbrechen. */
@\set_time_limit(0);
@\ini_set('max_execution_time', '0');

tk\weslie\WatchTogether\Api::handle();
