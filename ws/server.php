<?php
/**
 * Der langlaufende Prozess fuer die Live-Verbindung.
 *
 *   php ws/server.php start          im Vordergrund
 *   php ws/server.php start -d       im Hintergrund (nicht unter Windows)
 *   php ws/server.php stop
 *
 * Der Browser verbindet sich mit ws://<host>:<port>/?room=<raum>&name=<name>.
 */
declare(strict_types=1);

require __DIR__ . '/../vendor/autoload.php';

use tk\weslie\WatchTogether\Cleanup;
use tk\weslie\WatchTogether\Config;
use tk\weslie\WatchTogether\Files;
use tk\weslie\WatchTogether\Ws\Hub;
use Workerman\Timer;
use Workerman\Worker;

Files::ensureDir((string)Config::get('mediaDir'));

$hub = new Hub();

$worker = new Worker('websocket://' . Config::get('wsHost') . ':' . Config::get('wsPort'));
$worker->name  = 'watch-together';
$worker->count = 1;   /* Der Raumzustand liegt im Speicher, also genau ein Prozess. */

/* Raum und Name stehen in der Adresse des Handshakes. */
$worker->onWebSocketConnect = function ($conn, $header) use ($hub): void {
    $hub->join(
        $conn,
        (string)($_GET['room'] ?? ''),
        (string)($_GET['name'] ?? '')
    );
};

$worker->onMessage = function ($conn, $data) use ($hub): void {
    $hub->message($conn, \is_string($data) ? $data : '');
};

$worker->onClose = function ($conn) use ($hub): void {
    $hub->leave($conn);
};

$worker->onWorkerStart = function () use ($hub): void {
    /* Positionen der Teilnehmer, einmal pro Sekunde. Im selben Takt wird
       geprueft, von wem schon zu lange nichts mehr kam. */
    Timer::add(1.0, function () use ($hub): void {
        $hub->tickPositions();
        $hub->tickTimeouts();
    });

    /* Liegengebliebene Teildateien, alle 15 Minuten. */
    Timer::add(900, function (): void {
        Cleanup::run();
    });
};

Worker::runAll();
