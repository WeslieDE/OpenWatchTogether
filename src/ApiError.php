<?php
/**
 * Fehler, der so beim Browser ankommen darf. Alles andere bleibt im Log.
 */
declare(strict_types=1);

namespace tk\weslie\WatchTogether;

final class ApiError extends \RuntimeException
{
    public string $reason;
    public int $status;

    public function __construct(string $reason, string $message, int $status = 400)
    {
        parent::__construct($message);
        $this->reason = $reason;
        $this->status = $status;
    }
}
