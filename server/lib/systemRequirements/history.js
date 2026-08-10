function appendHistory(db, {
  requirementId,
  eventType,
  actorId,
  fromStatus = null,
  toStatus = null,
  payload = null,
}) {
  const info = db.prepare(`
    INSERT INTO sysreq_history
      (requirement_id, event_type, actor_id, from_status, to_status, payload_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    requirementId,
    eventType,
    actorId ?? null,
    fromStatus,
    toStatus,
    payload == null ? null : JSON.stringify(payload),
  );
  return info.lastInsertRowid;
}

function listHistory(db, requirementId, { limit = 50, offset = 0 } = {}) {
  return db.prepare(`
    SELECT h.*, u.name AS actor_name
    FROM sysreq_history h
    LEFT JOIN users u ON u.id = h.actor_id
    WHERE h.requirement_id = ?
    ORDER BY h.created_at DESC, h.id DESC
    LIMIT ? OFFSET ?
  `).all(requirementId, limit, offset);
}

module.exports = { appendHistory, listHistory };
