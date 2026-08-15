'use strict';
/* ============================================================================
 * tk.weslie.WatchTogether SFU - auth
 *
 * Der SFU-Prozess kennt weder Raeume noch Taktgeber - das entscheidet allein
 * Hub.php (src/Ws/Hub.php). Bevor jemand senden darf, muss er ein Token
 * vorzeigen, das der PHP-Prozess mit demselben gemeinsamen Geheimnis
 * unterschrieben hat (WT_SFU_SECRET, siehe Hub::liveToken()).
 * ========================================================================= */

const crypto = require('crypto');

/**
 * @param {string} secret gemeinsames Geheimnis, leer erlaubt (wie beim Rest
 *   der App gibt es ohne Angabe keinen Passwortschutz)
 * @param {string} room
 * @param {string} peer
 * @param {string|number} exp Unix-Zeitstempel, ab dem das Token nicht mehr gilt
 * @param {string} sig
 */
function verifyProduceToken(secret, room, peer, exp, sig) {
  if (!room || !peer || !exp || !sig) return false;

  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || Math.floor(expNum) !== expNum) return false;
  if (expNum < Math.floor(Date.now() / 1000)) return false;

  const expected = crypto
    .createHmac('sha256', secret || '')
    .update(`${room}|${peer}|${expNum}`)
    .digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(sig), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { verifyProduceToken };
