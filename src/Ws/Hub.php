<?php
/**
 * Die Live-Verbindung. Haelt den Zustand aller Raeume und verteilt die
 * Nachrichten zwischen den Teilnehmern.
 *
 *   Server an Client
 *     welcome     kompletter Raumzustand beim Verbinden
 *     joined      jemand ist dazugekommen
 *     left        jemand ist gegangen
 *     named       jemand hat seinen Namen geaendert
 *     master      wer den Takt vorgibt
 *     video       Spielt oder pausiert samt Zeit, vom Taktgeber
 *     pos         Position der anderen Teilnehmer
 *     upload      laufender Upload mit Fortschritt
 *     upload-end  Upload fertig oder abgebrochen
 *     queue       Warteschlange, sobald sich etwas daran geaendert hat
 *     now         welches Video gerade laeuft
 *     ready       jemand hat das laufende Video geladen
 *
 * Wird der letzte Teilnehmer verabschiedet, bleibt die Stelle des laufenden
 * Videos in der Datenbank des Raumes stehen. Wer den Raum wieder aufweckt,
 * bekommt sie im welcome als "resume" mit.
 *
 *   Client an Server
 *     pos, video, take, name, upload, upload-end, changed, now, ready, bye
 *
 * Lautstaerke und Ton gehen bewusst nicht ueber die Leitung.
 */
declare(strict_types=1);

namespace tk\weslie\WatchTogether\Ws;

use tk\weslie\WatchTogether\Db;
use tk\weslie\WatchTogether\Rooms;

final class Hub
{
    /** @var array<string,Room> slug => Raum */
    private array $rooms = [];

    /** @var array<int,array{slug:string,peer:string}> Verbindung => Zuordnung */
    private array $seats = [];

    /* --------------------------------------------------------- Verbindung -- */

    public function join($conn, string $rawRoom, string $rawName): void
    {
        $slug = Rooms::normalize($rawRoom);
        if ($slug === '') {
            $this->to($conn, 'denied', ['reason' => 'room']);
            $conn->close();
            return;
        }

        Rooms::ensure($slug);
        Rooms::touch($slug);

        $revived = !isset($this->rooms[$slug]);
        $room    = $this->rooms[$slug] ??= new Room($slug);
        $id      = \bin2hex(\random_bytes(4));
        $peer    = $room->add($id, \mb_substr(\trim($rawName), 0, 24, 'UTF-8'), $conn);

        $this->seats[$conn->id] = ['slug' => $slug, 'peer' => $id];

        $db = Db::of($slug);

        /* Der erste in einem wieder erwachten Raum: das Video steht dort, wo
           es beim Verlassen stand, und wartet angehalten auf ihn. Der Merker
           hat seinen Zweck erfuellt und geht weg. */
        $resume = 0.0;
        if ($revived) {
            $resume = $db->mark();
            $db->keepMark(null, 0.0);
            $room->setVideo(false, $resume);
        }

        /* Der gespeicherte Zustand geht an den neuen Teilnehmer. */
        $this->to($conn, 'welcome', [
            'you'     => ['id' => $id, 'name' => $peer['name'], 'color' => $peer['color']],
            'peers'   => $room->listing(),
            'master'  => $room->master,
            'video'   => $room->videoState(),
            'uploads' => \array_values(\array_map(
                static function ($u) {
                    return ['id' => $u['id'], 'byId' => $u['byId'], 'by' => $u['by'], 'title' => $u['title'], 'pct' => $u['pct']];
                },
                $room->uploads
            )),
            'queue'   => $db->queue(),
            'now'     => $db->meta('now'),
            'resume'  => \round($resume, 3),
        ]);

        $this->broadcast($room, 'joined', [
            'id' => $id, 'name' => $peer['name'], 'color' => $peer['color'],
        ], $id);
    }

    public function leave($conn): void
    {
        $seat = $this->seats[$conn->id] ?? null;
        if ($seat === null) {
            return;
        }
        unset($this->seats[$conn->id]);

        $room = $this->rooms[$seat['slug']] ?? null;
        if ($room === null) {
            return;
        }
        $id = $seat['peer'];

        /* Wer geht, nimmt seine laufenden Uebertragungen mit. */
        foreach ($room->uploads as $uid => $upload) {
            if ($upload['byId'] === $id) {
                unset($room->uploads[$uid]);
                $this->broadcast($room, 'upload-end', ['id' => $uid, 'ok' => false]);
            }
        }

        $wasMaster = $room->drop($id);
        $this->broadcast($room, 'left', ['id' => $id]);
        if ($wasMaster && $room->master !== null) {
            $this->broadcast($room, 'master', ['id' => $room->master]);
        }

        Rooms::touch($seat['slug']);

        /* Leerer Raum: der Zustand wird vergessen. Die Warteschlange bleibt,
           bis sie abgelaufen ist. Wo das Video stand, wird gemerkt, damit die
           Runde spaeter an derselben Stelle weiterschauen kann. */
        if ($room->empty()) {
            $db = Db::of($seat['slug']);
            $db->keepMark($db->meta('now'), $room->videoTime());
            unset($this->rooms[$seat['slug']]);
            Db::forget($seat['slug']);
        }
    }

    /* ---------------------------------------------------------- Empfangen -- */

    public function message($conn, string $raw): void
    {
        $seat = $this->seats[$conn->id] ?? null;
        if ($seat === null) {
            return;
        }
        $room = $this->rooms[$seat['slug']] ?? null;
        if ($room === null) {
            return;
        }

        $msg = \json_decode($raw, true);
        if (!\is_array($msg) || !isset($msg['type'])) {
            return;
        }
        $type = (string)$msg['type'];
        $d    = \is_array($msg['data'] ?? null) ? $msg['data'] : [];
        $id   = $seat['peer'];
        $slug = $seat['slug'];

        switch ($type) {

            /* Eigene Position. Wird gesammelt und im Takt weitergereicht. */
            case 'pos':
                $room->peers[$id]['pos'] = (float)($d['t'] ?? 0);
                break;

            /* Zustand des Videos. Nur der Taktgeber darf ihn setzen. */
            case 'video':
                if ($room->master !== $id) {
                    break;
                }
                $ran = $room->video['playing'];
                $room->setVideo((bool)($d['playing'] ?? false), (float)($d['t'] ?? 0));
                $this->broadcast($room, 'video', $room->videoState(), $id);

                /* Beim Anhalten die Stelle festhalten. Dann ist sie auch dann
                   noch da, wenn der Dienst zwischendurch neu startet. */
                if ($ran && !$room->video['playing']) {
                    $db = Db::of($slug);
                    $db->keepMark($db->meta('now'), $room->video['t']);
                }
                break;

            case 'take':
                if ($room->master === $id) {
                    break;
                }
                /* Der Stand wird eingefroren, damit der Wechsel nichts verschiebt. */
                $room->setVideo($room->video['playing'], $room->videoTime());
                $room->master = $id;
                $this->broadcast($room, 'master', ['id' => $id]);
                break;

            case 'name':
                $name = \mb_substr(\trim((string)($d['name'] ?? '')), 0, 24, 'UTF-8');
                if ($name === '') {
                    break;
                }
                $room->peers[$id]['name'] = $name;
                foreach ($room->uploads as $uid => $upload) {
                    if ($upload['byId'] === $id) {
                        $room->uploads[$uid]['by'] = $name;
                    }
                }
                /* Auch schon abgelegte Videos tragen den neuen Namen. */
                Db::of($slug)->rename($id, $name);
                $this->broadcast($room, 'named', ['id' => $id, 'name' => $name]);
                break;

            /* Laufende Uebertragung. Der Server merkt sich den Stand, damit ihn
               auch sieht, wer erst danach dazukommt. */
            case 'upload':
                $uid = (string)($d['id'] ?? '');
                if ($uid === '') {
                    break;
                }
                $room->uploads[$uid] = [
                    'id'    => $uid,
                    'byId'  => $id,
                    'by'    => $room->peers[$id]['name'],
                    'title' => \mb_substr((string)($d['title'] ?? ''), 0, 120, 'UTF-8'),
                    'pct'   => \max(0, \min(100, (float)($d['pct'] ?? 0))),
                ];
                $this->broadcast($room, 'upload', $room->uploads[$uid], $id);
                break;

            case 'upload-end':
                $uid = (string)($d['id'] ?? '');
                unset($room->uploads[$uid]);
                $this->broadcast($room, 'upload-end', [
                    'id' => $uid,
                    'ok' => (bool)($d['ok'] ?? false),
                ], $id);
                if (!empty($d['ok'])) {
                    /* Der Eintrag steht jetzt in der Datenbank. Alle holen sich
                       die frische Liste. */
                    $this->sendQueue($room);
                }
                break;

            /* An der Warteschlange hat sich etwas geaendert, etwa nach dem
               Loeschen eines Videos. */
            case 'changed':
                $this->sendQueue($room);
                break;

            /* Welches Video laeuft. Gibt der Taktgeber vor. */
            case 'now':
                if ($room->master !== $id) {
                    break;
                }
                $itemId = (string)($d['id'] ?? '');
                Db::of($slug)->setMeta('now', $itemId === '' ? null : $itemId);
                /* Alle laden neu, also ist niemand mehr bereit. */
                $room->clearReady();
                $this->broadcast($room, 'now', ['id' => $itemId === '' ? null : $itemId], $id);
                break;

            /* Wer das Video im Puffer hat, sagt es. Der Taktgeber laesst es
               losgehen, sobald alle so weit sind. Die Angabe traegt das Video
               mit sich, damit eine spaete Meldung nicht faelschlich fuer das
               naechste gilt. */
            case 'ready':
                $item = (string)($d['item'] ?? '');
                $room->peers[$id]['ready'] = $item === '' ? null : $item;
                $this->broadcast($room, 'ready', [
                    'id'   => $id,
                    'item' => $room->peers[$id]['ready'],
                ], $id);
                break;

            case 'bye':
                $conn->close();
                break;
        }

        Rooms::touch($slug);
    }

    /* ------------------------------------------------------------- Takt --- */

    /** Positionen der Teilnehmer, einmal pro Sekunde an alle im Raum. */
    public function tickPositions(): void
    {
        foreach ($this->rooms as $room) {
            if ($room->empty()) {
                continue;
            }
            $out = [];
            foreach ($room->peers as $id => $peer) {
                $out[$id] = \round((float)$peer['pos'], 3);
            }
            $this->broadcast($room, 'pos', $out);
        }
    }

    /* ------------------------------------------------------------ Senden -- */

    private function sendQueue(Room $room): void
    {
        $db = Db::of($room->slug);
        $this->broadcast($room, 'queue', ['items' => $db->queue()]);
    }

    private function broadcast(Room $room, string $type, array $data, ?string $except = null): void
    {
        $line = self::pack($type, $data);
        foreach ($room->peers as $id => $peer) {
            if ($id === $except) {
                continue;
            }
            $peer['conn']->send($line);
        }
    }

    private function to($conn, string $type, array $data): void
    {
        $conn->send(self::pack($type, $data));
    }

    private static function pack(string $type, array $data): string
    {
        return (string)\json_encode(
            ['type' => $type, 'data' => $data],
            \JSON_UNESCAPED_UNICODE | \JSON_UNESCAPED_SLASHES
        );
    }
}
