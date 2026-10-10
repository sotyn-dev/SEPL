// One row per employee/template pair. Weekly KPI entries remain keyed by KPI,
// so changing assignments never deletes recorded scores or personal targets.
function initialize(db) {
  const columns = db.prepare('PRAGMA table_info(score_user_template)').all();
  if (columns.find(c => c.name === 'template_id')?.pk !== 2) {
    db.transaction(() => {
      db.exec(`CREATE TABLE score_user_template_multi (
        user_id INTEGER NOT NULL REFERENCES users(id),
        template_id INTEGER NOT NULL REFERENCES score_templates(id),
        assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        assigned_by INTEGER REFERENCES users(id),
        PRIMARY KEY (user_id, template_id)
      );
      INSERT INTO score_user_template_multi (user_id,template_id,assigned_at,assigned_by)
        SELECT user_id,template_id,assigned_at,assigned_by FROM score_user_template
        WHERE template_id IS NOT NULL;
      DROP TABLE score_user_template;
      ALTER TABLE score_user_template_multi RENAME TO score_user_template;`);
    })();
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_score_user_template_template ON score_user_template(template_id)');
}

function listAssignments(db) {
  const users = db.prepare(`SELECT id AS user_id,name,role,department FROM users
    WHERE COALESCE(active,1)=1 ORDER BY name,id`).all();
  const links = db.prepare(`SELECT ut.user_id,t.id,t.name,COALESCE(t.active,1) AS active
    FROM score_user_template ut JOIN score_templates t ON t.id=ut.template_id
    ORDER BY t.name,t.id`).all();
  const byUser = new Map();
  for (const { user_id, ...template } of links) {
    if (!byUser.has(user_id)) byUser.set(user_id, []);
    byUser.get(user_id).push(template);
  }
  return users.map(u => {
    const templates = byUser.get(u.user_id) || [];
    return { ...u, templates, template_ids: templates.map(t => t.id),
      template_id: templates[0]?.id ?? null,
      template_name: templates.map(t => t.name).join(' + ') || null };
  });
}

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function setAssignments(db, userId, body, assignedBy) {
  return db.transaction(() => {
    if (!Number.isSafeInteger(userId) || userId <= 0 ||
        !db.prepare('SELECT 1 FROM users WHERE id=? AND COALESCE(active,1)=1').get(userId)) {
      fail(404, 'Active employee not found');
    }
    const current = db.prepare('SELECT template_id FROM score_user_template WHERE user_id=?').all(userId).map(r => r.template_id);
    let requested;
    if (Array.isArray(body?.template_ids)) requested = body.template_ids;
    else if (body && !Object.hasOwn(body, 'template_ids') && Object.hasOwn(body, 'template_id')) {
      // Older cached clients must not silently replace a multi-template selection.
      if (current.length > 1) fail(409, 'This employee has multiple templates. Refresh the page before changing assignments.');
      requested = body.template_id == null || body.template_id === '' ? [] : [body.template_id];
    } else fail(400, 'template_ids must be an array');
    if (requested.some(id => !((typeof id === 'number' || (typeof id === 'string' && /^\d+$/.test(id))) && Number.isSafeInteger(Number(id)) && Number(id) > 0))) {
      fail(400, 'Every template ID must be a positive integer');
    }
    const ids = [...new Set(requested.map(Number))];
    const find = db.prepare('SELECT COALESCE(active,1) AS active FROM score_templates WHERE id=?');
    for (const id of ids) {
      const template = find.get(id);
      if (!template || (!template.active && !current.includes(id))) fail(400, 'Select existing, active templates');
    }
    const remove = db.prepare('DELETE FROM score_user_template WHERE user_id=? AND template_id=?');
    const add = db.prepare('INSERT INTO score_user_template(user_id,template_id,assigned_by) VALUES(?,?,?) ON CONFLICT(user_id,template_id) DO NOTHING');
    for (const id of current) if (!ids.includes(id)) remove.run(userId, id);
    for (const id of ids) add.run(userId, id, assignedBy);
    return ids;
  })();
}

module.exports = { initialize, listAssignments, setAssignments };
