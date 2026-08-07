// System Requirements — SQLite schema (idempotent).
// Spec: docs/SYSTEM_REQUIREMENTS.md

const STATUS_CHECK = `
  'draft','submitted','under_review','need_clarification','approved','rejected',
  'planned','assigned','pending','in_progress','in_development',
  'testing','released','done','closed','archived','reopened'
`;

function recreateRequirementsTable(db) {
  // Child tables (history/comments/attachments) FK to requirements — must disable
  // FK checks for DROP/RENAME. PRAGMA foreign_keys cannot change inside a transaction.
  const fkWasOn = db.pragma('foreign_keys', { simple: true });
  db.pragma('foreign_keys = OFF');
  try {
    db.exec(`DROP TABLE IF EXISTS sysreq_requirements__new`);
    db.exec(`
      CREATE TABLE sysreq_requirements__new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        req_number TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        description TEXT,
        type TEXT NOT NULL DEFAULT 'enhancement'
          CHECK(type IN (
            'new_feature','enhancement','bug_fix','ui_improvement','report_request',
            'automation','performance','integration','technical_debt','refactoring'
          )),
        status TEXT NOT NULL DEFAULT 'draft'
          CHECK(status IN (${STATUS_CHECK})),
        priority TEXT NOT NULL DEFAULT 'medium'
          CHECK(priority IN ('low','medium','high','urgent')),
        requested_by INTEGER REFERENCES users(id),
        assignee_id INTEGER REFERENCES users(id),
        due_date DATE,
        target_start_date DATE,
        target_version TEXT,
        release_version TEXT,
        release_notes TEXT,
        completed_at DATETIME,
        tech_analysis TEXT,
        impl_strategy TEXT,
        dev_notes TEXT,
        testing_notes TEXT,
        completion_summary TEXT,
        business_approved_at DATETIME,
        business_approved_by INTEGER REFERENCES users(id),
        it_approved_at DATETIME,
        it_approved_by INTEGER REFERENCES users(id),
        soft_deleted_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_by INTEGER REFERENCES users(id),
        updated_by INTEGER REFERENCES users(id)
      );

      INSERT INTO sysreq_requirements__new (
        id, req_number, title, description, type, status, priority,
        requested_by, assignee_id,
        due_date, target_start_date, target_version, release_version, release_notes,
        completed_at, tech_analysis, impl_strategy, dev_notes,
        testing_notes, completion_summary,
        business_approved_at, business_approved_by, it_approved_at, it_approved_by,
        soft_deleted_at, created_at, updated_at, created_by, updated_by
      )
      SELECT
        id, req_number, title, description, type,
        CASE
          WHEN status = 'in_development' THEN 'pending'
          ELSE status
        END,
        priority,
        requested_by, assignee_id,
        due_date, target_start_date, target_version, release_version, release_notes,
        completed_at, tech_analysis, impl_strategy, dev_notes,
        testing_notes, completion_summary,
        business_approved_at, business_approved_by, it_approved_at, it_approved_by,
        soft_deleted_at, created_at, updated_at, created_by, updated_by
      FROM sysreq_requirements;

      DROP TABLE sysreq_requirements;
      ALTER TABLE sysreq_requirements__new RENAME TO sysreq_requirements;
    `);
  } finally {
    db.pragma(`foreign_keys = ${fkWasOn ? 'ON' : 'OFF'}`);
  }
}

/** Post-release closed rows → done (history had released). Early closed stays closed. */
function migratePostReleaseClosedToDone(db) {
  try {
    db.prepare(`
      UPDATE sysreq_requirements
      SET status = 'done'
      WHERE status = 'closed'
        AND id IN (
          SELECT DISTINCT requirement_id FROM sysreq_history WHERE to_status = 'released'
        )
    `).run();
  } catch (e) {
    console.warn('[sysreq] migrate closed→done skipped:', e.message);
  }
}

function ensureStatusConstraint(db) {
  const row = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='sysreq_requirements'`
  ).get();
  if (!row?.sql) return;

  const hasDone = row.sql.includes("'done'");
  const hasPending = row.sql.includes("'pending'") && row.sql.includes("'in_progress'");

  if (!hasPending || !hasDone) {
    recreateRequirementsTable(db);
  } else {
    db.prepare(
      `UPDATE sysreq_requirements SET status='pending' WHERE status='in_development'`
    ).run();
  }
  migratePostReleaseClosedToDone(db);
}

function ensureAttachmentAndCommentColumns(db) {
  try {
    const commentCols = db.prepare(`PRAGMA table_info(sysreq_comments)`).all();
    const commentNames = new Set(commentCols.map(c => c.name));
    if (!commentNames.has('source')) {
      db.exec(`ALTER TABLE sysreq_comments ADD COLUMN source TEXT NOT NULL DEFAULT 'user'`);
    }

    const attCols = db.prepare(`PRAGMA table_info(sysreq_attachments)`).all();
    const attNames = new Set(attCols.map(c => c.name));
    if (!attNames.has('comment_id')) {
      db.exec(`ALTER TABLE sysreq_attachments ADD COLUMN comment_id INTEGER REFERENCES sysreq_comments(id)`);
    }
    if (!attNames.has('dev_section')) {
      db.exec(`ALTER TABLE sysreq_attachments ADD COLUMN dev_section TEXT`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sysreq_attach_comment ON sysreq_attachments(comment_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sysreq_attach_dev ON sysreq_attachments(dev_section)`);
  } catch (e) {
    console.warn('[sysreq] attachment/comment columns skipped:', e.message);
  }
}

function dropAiPromptNotesColumn(db) {
  try {
    const cols = db.prepare(`PRAGMA table_info(sysreq_requirements)`).all();
    if (!cols.some(c => c.name === 'ai_prompt_notes')) return;
    db.exec(`ALTER TABLE sysreq_requirements DROP COLUMN ai_prompt_notes`);
  } catch (e) {
    console.warn('[sysreq] drop ai_prompt_notes skipped:', e.message);
  }
}

function dropModuleDepartmentColumns(db) {
  try {
    const cols = db.prepare(`PRAGMA table_info(sysreq_requirements)`).all();
    const names = new Set(cols.map(c => c.name));
    // Drop dependent index first (SQLite refuses DROP COLUMN while index references it)
    try { db.exec(`DROP INDEX IF EXISTS idx_sysreq_module`); } catch { /* ignore */ }
    if (names.has('module_name')) {
      db.exec(`ALTER TABLE sysreq_requirements DROP COLUMN module_name`);
    }
    if (names.has('department')) {
      db.exec(`ALTER TABLE sysreq_requirements DROP COLUMN department`);
    }
  } catch (e) {
    console.warn('[sysreq] drop module/department skipped:', e.message);
  }
}

function runSystemRequirementsMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sysreq_requirements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      req_number TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      description TEXT,
      type TEXT NOT NULL DEFAULT 'enhancement'
        CHECK(type IN (
          'new_feature','enhancement','bug_fix','ui_improvement','report_request',
          'automation','performance','integration','technical_debt','refactoring'
        )),
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN (${STATUS_CHECK})),
      priority TEXT NOT NULL DEFAULT 'medium'
        CHECK(priority IN ('low','medium','high','urgent')),
      requested_by INTEGER REFERENCES users(id),
      assignee_id INTEGER REFERENCES users(id),
      due_date DATE,
      target_start_date DATE,
      target_version TEXT,
      release_version TEXT,
      release_notes TEXT,
      completed_at DATETIME,
      tech_analysis TEXT,
      impl_strategy TEXT,
      dev_notes TEXT,
      testing_notes TEXT,
      completion_summary TEXT,
      business_approved_at DATETIME,
      business_approved_by INTEGER REFERENCES users(id),
      it_approved_at DATETIME,
      it_approved_by INTEGER REFERENCES users(id),
      soft_deleted_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_by INTEGER REFERENCES users(id),
      updated_by INTEGER REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS sysreq_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      requirement_id INTEGER NOT NULL REFERENCES sysreq_requirements(id),
      parent_id INTEGER REFERENCES sysreq_comments(id),
      body TEXT NOT NULL,
      author_id INTEGER NOT NULL REFERENCES users(id),
      source TEXT NOT NULL DEFAULT 'user',
      soft_deleted_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sysreq_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      requirement_id INTEGER NOT NULL REFERENCES sysreq_requirements(id),
      event_type TEXT NOT NULL,
      actor_id INTEGER REFERENCES users(id),
      from_status TEXT,
      to_status TEXT,
      payload_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sysreq_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      requirement_id INTEGER NOT NULL REFERENCES sysreq_requirements(id),
      comment_id INTEGER REFERENCES sysreq_comments(id),
      dev_section TEXT,
      original_filename TEXT NOT NULL,
      stored_filename TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      file_size INTEGER NOT NULL DEFAULT 0,
      mime_type TEXT,
      uploaded_by INTEGER REFERENCES users(id),
      soft_deleted_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sysreq_watchers (
      requirement_id INTEGER NOT NULL REFERENCES sysreq_requirements(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (requirement_id, user_id)
    );
  `);

  ensureStatusConstraint(db);
  dropAiPromptNotesColumn(db);
  dropModuleDepartmentColumns(db);
  ensureAttachmentAndCommentColumns(db);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sysreq_status ON sysreq_requirements(status);
    CREATE INDEX IF NOT EXISTS idx_sysreq_assignee ON sysreq_requirements(assignee_id);
    CREATE INDEX IF NOT EXISTS idx_sysreq_priority ON sysreq_requirements(priority);
    CREATE INDEX IF NOT EXISTS idx_sysreq_due ON sysreq_requirements(due_date);
    CREATE INDEX IF NOT EXISTS idx_sysreq_updated ON sysreq_requirements(updated_at);
    CREATE INDEX IF NOT EXISTS idx_sysreq_hist_req ON sysreq_history(requirement_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_sysreq_hist_type ON sysreq_history(event_type, created_at);
    CREATE INDEX IF NOT EXISTS idx_sysreq_comments_req ON sysreq_comments(requirement_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_sysreq_attach_req ON sysreq_attachments(requirement_id);
    CREATE INDEX IF NOT EXISTS idx_sysreq_watchers_user ON sysreq_watchers(user_id);
  `);
}

module.exports = { runSystemRequirementsMigrations };
