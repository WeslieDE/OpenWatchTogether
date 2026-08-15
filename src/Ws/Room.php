<?php
/**
 * Der Zustand eines Raumes im laufenden Prozess: wer da ist, wer den Takt
 * vorgibt, wo das Video steht und was gerade hochgeladen wird.
 *
 * Der Zustand bleibt, bis niemand mehr im Raum ist. Was in der Warteschlange
 * liegt, steht dagegen in der Datenbank des Raumes und ueberlebt auch das.
 */
declare(strict_types=1);

namespace tk\weslie\WatchTogether\Ws;

final class Room
{
    /** Farben fuer Namenskuerzel und Positionsmarken auf der Zeitleiste. */
    private const PALETTE = [
        '#3f7d6e', '#8a5a2b', '#4a5f9e', '#8d4257',
        '#3d6b8e', '#6a5b96', '#7a6a2e', '#4f6d3a',
    ];

    public string $slug;

    /** @var array<string,array<string,mixed>> peerId => Teilnehmer */
    public array $peers = [];

    /** @var list<string> Reihenfolge des Beitritts */
    public array $order = [];

    public ?string $master = null;

    /** @var array{playing:bool,t:float,at:float} */
    public array $video = ['playing' => false, 't' => 0.0, 'at' => 0.0];

    /** @var array<string,array<string,mixed>> laufende Uebertragungen */
    public array $uploads = [];

    /** Laeuft gerade eine Bildschirmuebertragung, und wer sie ueberhaupt sendet. */
    public bool $live = false;
    public ?string $liveBy = null;

    private int $colors = 0;

    public function __construct(string $slug)
    {
        $this->slug = $slug;
        $this->video['at'] = \microtime(true);
    }

    /* ------------------------------------------------------- Teilnehmer -- */

    public function add(string $id, string $name, $conn): array
    {
        $peer = [
            'id'    => $id,
            'name'  => $this->freeName($name),
            'color' => self::PALETTE[$this->colors++ % \count(self::PALETTE)],
            'conn'  => $conn,
            'pos'   => 0.0,
            /* Welches Video dieser Teilnehmer geladen hat. Null heisst: noch
               keines, der Raum wartet also gegebenenfalls auf ihn. */
            'ready' => null,
            /* Sein Zeichen im Bereit-Modus. Der Server merkt es sich nur und
               reicht es weiter; entschieden wird damit im Browser. */
            'go'    => false,
            /* Wann zuletzt etwas von ihm kam. Bleibt es lange aus, ist die
               Leitung tot und der Platz wird geraeumt. */
            'seen'  => \microtime(true),
            /* Steht seine Verbindung zum SFU, waehrend eine Uebertragung
               laeuft? Meldet er selbst, siehe "live-status". */
            'connected' => false,
        ];
        $this->peers[$id] = $peer;
        $this->order[] = $id;

        if ($this->master === null) {
            $this->master = $id;
        }
        return $peer;
    }

    /** Nimmt den Teilnehmer raus und sagt, ob er den Takt vorgegeben hat. */
    public function drop(string $id): bool
    {
        if (!isset($this->peers[$id])) {
            return false;
        }
        unset($this->peers[$id]);
        $this->order = \array_values(\array_filter(
            $this->order,
            static function ($x) use ($id) {
                return $x !== $id;
            }
        ));

        $wasMaster = $this->master === $id;
        if ($wasMaster) {
            $this->master = $this->order[0] ?? null;
        }
        return $wasMaster;
    }

    public function empty(): bool
    {
        return $this->order === [];
    }

    /** Name doppelt? Dann bekommt er eine Ziffer dazu. */
    private function freeName(string $wish): string
    {
        $wish = \trim($wish) === '' ? 'Gast' : \trim($wish);
        $taken = [];
        foreach ($this->peers as $peer) {
            $taken[\mb_strtolower($peer['name'], 'UTF-8')] = true;
        }
        if (!isset($taken[\mb_strtolower($wish, 'UTF-8')])) {
            return $wish;
        }
        for ($i = 2; $i < 100; $i++) {
            $candidate = $wish . ' ' . $i;
            if (!isset($taken[\mb_strtolower($candidate, 'UTF-8')])) {
                return $candidate;
            }
        }
        return $wish;
    }

    /** @return list<array<string,mixed>> Teilnehmer, wie der Browser sie kennt. */
    public function listing(): array
    {
        $out = [];
        foreach ($this->order as $id) {
            $out[] = [
                'id'    => $id,
                'name'  => $this->peers[$id]['name'],
                'color' => $this->peers[$id]['color'],
                'ready' => $this->peers[$id]['ready'],
                'go'    => $this->peers[$id]['go'],
                'connected' => $this->peers[$id]['connected'],
            ];
        }
        return $out;
    }

    /**
     * Ein anderes Video liegt an: was bisher geladen war, zaehlt nicht mehr.
     * Alle laden neu, also wartet der Raum wieder auf alle.
     */
    public function clearReady(): void
    {
        foreach (\array_keys($this->peers) as $id) {
            $this->peers[$id]['ready'] = null;
        }
    }

    /* ------------------------------------------------------------ Video -- */

    /** Zeit des Taktgebers, zwischen zwei Meldungen hochgerechnet. */
    public function videoTime(): float
    {
        if (!$this->video['playing']) {
            return $this->video['t'];
        }
        return $this->video['t'] + (\microtime(true) - $this->video['at']);
    }

    public function setVideo(bool $playing, float $t): void
    {
        $this->video = [
            'playing' => $playing,
            't'       => \max(0.0, $t),
            'at'      => \microtime(true),
        ];
    }

    /** @return array{playing:bool,t:float} */
    public function videoState(): array
    {
        return ['playing' => $this->video['playing'], 't' => \round($this->videoTime(), 3)];
    }

    /* ------------------------------------------------------------- Live -- */

    /** Uebertragung vorbei - ob gewollt beendet oder weil der Sender ging. */
    public function stopLive(): void
    {
        $this->live = false;
        $this->liveBy = null;
        foreach (\array_keys($this->peers) as $id) {
            $this->peers[$id]['connected'] = false;
        }
    }
}
