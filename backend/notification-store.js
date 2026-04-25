/**
 * NOTIFICATION STORE — Persistent per-user notification feed.
 *
 * Responsibilities:
 *   • Persist events (signal/trade/safety_gate/admin) to `notifications` table.
 *   • UNIQUE(key_id, event_id) prevents duplicate delivery.
 *   • Severity classification: CRITICAL/HIGH/MEDIUM/LOW/INFO.
 *   • CRITICAL events require user acknowledgement.
 *   • Reliable delivery: events persist even if user offline; surface on reconnect.
 *
 * Author: 2026-04-25 audit phase 3
 */
'use strict';

const crypto = require('crypto');
const { pool } = require('./database');

const VALID_SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];

/**
 * Compute deterministic event_id. Same inputs (eventType + signalId + ts bucket) → same id.
 * Bucketing by minute prevents two distinct generators producing different event_ids
 * for the "same" event milliseconds apart.
 */
function computeEventId(eventType, refKey, tsBucketMin) {
  const payload = `${eventType}|${refKey}|${tsBucketMin}`;
  return 'evt_' + crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

/**
 * Insert a notification. Idempotent via UNIQUE(key_id, event_id).
 * @returns { created: boolean, notif: object | null }
 */
async function insert({
  keyId,
  eventType,
  severity = 'INFO',
  title,
  body = '',
  refKey,
  tsBucketMin = null,
  meta = {}
}) {
  if (!keyId || !eventType || !title) {
    throw new Error('insert: missing required fields');
  }
  if (!VALID_SEVERITIES.includes(severity)) severity = 'INFO';
  const bucket = tsBucketMin != null ? tsBucketMin : Math.floor(Date.now() / 60000);
  const eventId = computeEventId(eventType, refKey || title, bucket);
  const sql = `
    INSERT INTO notifications (key_id, event_id, event_type, severity, title, body, meta)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (key_id, event_id) DO NOTHING
    RETURNING *
  `;
  const { rows } = await pool.query(sql, [keyId, eventId, eventType, severity, title, body, JSON.stringify(meta)]);
  return { created: rows.length > 0, notif: rows[0] || null, eventId };
}

/**
 * Get user's notifications, with optional unread filter.
 */
async function listForUser(keyId, { onlyUnread = false, limit = 50, sinceTs = null } = {}) {
  let where = 'key_id = $1';
  const params = [keyId];
  if (onlyUnread) where += ' AND read = 0';
  if (sinceTs) {
    params.push(new Date(sinceTs));
    where += ` AND ts > $${params.length}`;
  }
  params.push(limit);
  const sql = `SELECT * FROM notifications WHERE ${where} ORDER BY ts DESC LIMIT $${params.length}`;
  const { rows } = await pool.query(sql, params);
  return rows;
}

/**
 * Count unread for user.
 */
async function countUnread(keyId) {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM notifications WHERE key_id = $1 AND read = 0', [keyId]);
  return rows[0].n;
}

/**
 * Mark as read.
 */
async function markRead(keyId, ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    // Mark all
    await pool.query('UPDATE notifications SET read = 1 WHERE key_id = $1 AND read = 0', [keyId]);
    return { updated: 'all' };
  }
  const { rowCount } = await pool.query(
    'UPDATE notifications SET read = 1 WHERE key_id = $1 AND id = ANY($2)',
    [keyId, ids]
  );
  return { updated: rowCount };
}

/**
 * Acknowledge CRITICAL event. User must acknowledge before continuing certain actions.
 */
async function acknowledge(keyId, id) {
  const { rowCount } = await pool.query(
    'UPDATE notifications SET acknowledged = 1, read = 1 WHERE key_id = $1 AND id = $2',
    [keyId, id]
  );
  return rowCount > 0;
}

/**
 * Get unacknowledged CRITICAL events.
 */
async function getPendingCritical(keyId) {
  const { rows } = await pool.query(
    "SELECT * FROM notifications WHERE key_id = $1 AND severity = 'CRITICAL' AND acknowledged = 0 ORDER BY ts DESC",
    [keyId]
  );
  return rows;
}

module.exports = {
  computeEventId,
  insert,
  listForUser,
  countUnread,
  markRead,
  acknowledge,
  getPendingCritical,
  VALID_SEVERITIES
};
