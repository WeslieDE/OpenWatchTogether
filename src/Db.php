<?php
/**
 * Je Raum eine eigene SQLite-Datei. Darin steht, was in der Warteschlange
 * liegt: Dateiname, Laufzeit, Titel und wer es hinzugefuegt hat.
 */
declare(strict_types=1);

namespace tk\weslie\WatchTogether;

use PDO;

final class Db
{
    /** @var array<string,Db> Eine Verbindung je Raum. */
    private static array $open = [];

    private PDO $pdo;

    private function __construct(private string $slug)
    {
        $dir = Rooms::ensure($slug);
        $this->pdo = new PDO('sqlite:' . $dir . '/room.sqlite', null, null, [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        ]);
        $this->pdo->exec('PRAGMA journal_mode = WAL');
        $this->pdo->exec('PRAGMA busy_timeout = 5000');
        $this->schema();
    }

    public static function of(string $slug): self
    {
        return self::$open[$slug] ??= new self($slug);
    }

    private function schema(): void
    {
        $this->pdo->exec(
            'CREATE TABLE IF NOT EXISTS items (
                id          TEXT PRIMARY KEY,
                file        TEXT NOT NULL,
                poster      TEXT,
                title       TEXT NOT NULL,
                added_by    TEXT NOT NULL,
                added_by_id TEXT,
                duration    REAL NOT NULL DEFAULT 0,
                bytes       INTEGER NOT NULL DEFAULT 0,
                mime        TEXT NOT NULL DEFAULT "video/mp4",
                sort        INTEGER NOT NULL DEFAULT 0,
                created     INTEGER NOT NULL
            )'
        );
        $this->pdo->exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)');
    }

    /* ------------------------------------------------------------ Merker -- */

    public function meta(string $key, ?string $fallback = null): ?string
    {
        $q = $this->pdo->prepare('SELECT v FROM meta WHERE k = ?');
        $q->execute([$key]);
        $row = $q->fetch();
        return $row === false ? $fallback : (string)$row['v'];
    }

    public function setMeta(string $key, ?string $value): void
    {
        if ($value === null) {
            $this->pdo->prepare('DELETE FROM meta WHERE k = ?')->execute([$key]);
            return;
        }
        $this->pdo->prepare('INSERT INTO meta (k, v) VALUES (?, ?)
                             ON CONFLICT(k) DO UPDATE SET v = excluded.v')
            ->execute([$key, $value]);
    }

    /* ------------------------------------------ Einstellungen des Raums -- */
    /* Sie gehoeren dem Raum, nicht dem Browser: sie ueberleben das Verlassen,
       den Neustart des Dienstes und gelten fuer alle im Raum gleich.

         keep      Videos bleiben liegen, statt nach dem Abspielen wegzugehen
         opening   Ende des Vorspanns, gemessen vom Anfang der Datei
         ending    Anfang des Abspanns, gemessen vom Ende der Datei

       Null heisst jeweils: bleibt beim gewohnten Verhalten. */

    /** @return array{keep:bool,opening:float,ending:float} */
    public function settings(): array
    {
        return [
            'keep'    => $this->meta('keep', '0') === '1',
            'opening' => \max(0.0, (float)$this->meta('opening', '0')),
            'ending'  => \max(0.0, (float)$this->meta('ending', '0')),
        ];
    }

    /**
     * @param  array<string,mixed> $in
     * @return array{keep:bool,opening:float,ending:float}
     */
    public function setSettings(array $in): array
    {
        $this->setMeta('keep', empty($in['keep']) ? '0' : '1');
        $this->setMeta('opening', (string)self::seconds($in['opening'] ?? 0));
        $this->setMeta('ending', (string)self::seconds($in['ending'] ?? 0));
        return $this->settings();
    }

    /** Eine Zeitangabe in Sekunden. Mehr als eine Stunde Vorspann gibt es nicht. */
    private static function seconds(mixed $value): float
    {
        $v = \is_numeric($value) ? (float)$value : 0.0;
        return \round(\max(0.0, \min(3600.0, $v)), 1);
    }

    /** Bleibt dieser Raum stehen, weil in ihm noch Videos liegen sollen? */
    public static function keeps(string $slug): bool
    {
        $db = self::of($slug);
        return $db->settings()['keep'] && $db->count() > 0;
    }

    /* ----------------------------------------------- Stand des Videos ---- */
    /* Wird der Raum leer, geht der Stand im Speicher verloren. Damit die
       Runde spaeter dort weitermachen kann, wo sie aufgehoert hat, bleibt die
       Stelle in der Datenbank des Raumes stehen. */

    public function keepMark(?string $itemId, float $t): void
    {
        if ($itemId === null || $itemId === '' || $t <= 0.0) {
            $this->setMeta('mark', null);
            $this->setMeta('markId', null);
            return;
        }
        $this->setMeta('mark', (string)\round($t, 3));
        $this->setMeta('markId', $itemId);
    }

    /** Die gemerkte Stelle, aber nur wenn sie zum abgelegten Video passt. */
    public function mark(): float
    {
        $id  = $this->meta('markId');
        $row = $id === null || $id !== $this->meta('now') ? null : $this->row($id);
        if ($row === null) {
            return 0.0;
        }
        $t   = \max(0.0, (float)$this->meta('mark', '0'));
        $len = (float)$row['duration'];

        /* Kurz vor Schluss faengt man besser von vorne an. */
        return $len > 0.0 && $t > $len - 1.0 ? 0.0 : $t;
    }

    /* ----------------------------------------------------- Warteschlange -- */

    /** @return list<array<string,mixed>> Rohe Zeilen in Reihenfolge der Liste. */
    public function rows(): array
    {
        $q = $this->pdo->query('SELECT * FROM items ORDER BY sort ASC, created ASC');
        return $q === false ? [] : $q->fetchAll();
    }

    public function row(string $id): ?array
    {
        $q = $this->pdo->prepare('SELECT * FROM items WHERE id = ?');
        $q->execute([$id]);
        $row = $q->fetch();
        return $row === false ? null : $row;
    }

    /** Wie die Warteschlange beim Browser ankommt. */
    public function queue(): array
    {
        $out = [];
        foreach ($this->rows() as $row) {
            $out[] = self::toItem($this->slug, $row);
        }
        return $out;
    }

    public static function toItem(string $slug, array $row): array
    {
        $q = 'room=' . \rawurlencode($slug) . '&id=' . \rawurlencode((string)$row['id']);
        return [
            'id'        => (string)$row['id'],
            'title'     => (string)$row['title'],
            'addedBy'   => (string)$row['added_by'],
            'addedById' => $row['added_by_id'] !== null ? (string)$row['added_by_id'] : null,
            'duration'  => (float)$row['duration'],
            'bytes'     => (int)$row['bytes'],
            'url'       => 'api/index.php?do=media&' . $q,
            'poster'    => $row['poster'] !== null && $row['poster'] !== ''
                ? 'api/index.php?do=poster&' . $q
                : null,
            'created'   => (int)$row['created'],
        ];
    }

    public function add(array $item): void
    {
        $next = (int)($this->pdo->query('SELECT COALESCE(MAX(sort), 0) + 1 FROM items')?->fetchColumn() ?: 1);
        $q = $this->pdo->prepare(
            'INSERT INTO items (id, file, poster, title, added_by, added_by_id,
                                duration, bytes, mime, sort, created)
             VALUES (:id, :file, :poster, :title, :by, :byId, :dur, :bytes, :mime, :sort, :created)'
        );
        $q->execute([
            ':id'      => $item['id'],
            ':file'    => $item['file'],
            ':poster'  => $item['poster'] ?? null,
            ':title'   => $item['title'],
            ':by'      => $item['addedBy'],
            ':byId'    => $item['addedById'] ?? null,
            ':dur'     => $item['duration'] ?? 0,
            ':bytes'   => $item['bytes'] ?? 0,
            ':mime'    => $item['mime'] ?? 'video/mp4',
            ':sort'    => $next,
            ':created' => \time(),
        ]);
    }

    /** Loescht den Eintrag samt Video und Vorschaubild. */
    public function remove(string $id): bool
    {
        $row = $this->row($id);
        if ($row === null) {
            return false;
        }
        $dir = Rooms::dir($this->slug);
        @\unlink($dir . '/' . $row['file']);
        if (!empty($row['poster'])) {
            @\unlink($dir . '/' . $row['poster']);
        }
        $this->pdo->prepare('DELETE FROM items WHERE id = ?')->execute([$id]);
        if ($this->meta('now') === $id) {
            $this->setMeta('now', null);
        }
        return true;
    }

    /** Namen nachziehen, wenn sich jemand umbenennt. */
    public function rename(string $peerId, string $name): void
    {
        $this->pdo->prepare('UPDATE items SET added_by = ? WHERE added_by_id = ?')
            ->execute([$name, $peerId]);
    }

    public function count(): int
    {
        return (int)($this->pdo->query('SELECT COUNT(*) FROM items')?->fetchColumn() ?: 0);
    }

    /** Verbindung schliessen, damit die Datei geloescht werden kann. */
    public static function forget(string $slug): void
    {
        unset(self::$open[$slug]);
    }
}
