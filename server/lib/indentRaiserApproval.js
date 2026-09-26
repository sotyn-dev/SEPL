// Snapshot the new workflow at creation; never migrate old/pending indents.
const START_DATE = '2026-09-28';
const usesRaiserApproval = row => Number(row?.raiser_approval_required) === 1;
const appliesOn = istDate => istDate >= START_DATE;

function migrate(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(indents)').all().map(c => c.name));
  if (!columns.size) return;
  if (!columns.has('raiser_approval_required')) db.exec('ALTER TABLE indents ADD COLUMN raiser_approval_required INTEGER NOT NULL DEFAULT 0');
  if (!columns.has('review_revision')) db.exec('ALTER TABLE indents ADD COLUMN review_revision INTEGER NOT NULL DEFAULT 0');
  db.exec(`CREATE TABLE IF NOT EXISTS indent_review_audit (
    id INTEGER PRIMARY KEY, indent_id INTEGER NOT NULL REFERENCES indents(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL, action TEXT NOT NULL, actor_id INTEGER NOT NULL,
    details TEXT, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
}

function audit(db, row, actorId, action, details = {}) {
  db.prepare('INSERT INTO indent_review_audit (indent_id, revision, action, actor_id, details) VALUES (?,?,?,?,?)')
    .run(row.id, row.review_revision || 0, action, actorId, JSON.stringify(details));
  if (action !== 'marked_correct') db.prepare('UPDATE notifications SET read_at=COALESCE(read_at,CURRENT_TIMESTAMP) WHERE dedupe_key=?')
    .run(`indent-raiser:${row.id}:${row.review_revision}`);
}

function validateAction(row, actorId, reviewerIds, body) {
  const fail = (error, code = 403) => ({ error, code });
  if (!usesRaiserApproval(row)) return null;
  if (body.status === 'rejected') return fail('This workflow has no reject action. Save corrections and have the indent reviewed again.');
  // CRM still runs through the existing permission and billing checks.
  if (row.crm_status === 'pending' && row.status === 'submitted' && body.status === 'approved') return null;
  if (!['reviewed', 'approved'].includes(body.status)) return fail('Use review and raiser approval; direct status changes are not allowed.');
  if (!Number.isInteger(body.review_revision) || body.review_revision !== row.review_revision) return fail('This indent changed. Reload it before acting.', 409);
  const pendingReview = ['submitted', 'crm_approved'].includes(row.status) && row.l1_status === 'pending';
  const pendingRaiser = row.status === 'l1_approved' && row.l1_status === 'approved';
  if (body.status === 'reviewed') {
    if (!pendingReview || row.crm_status === 'pending') return fail('This indent is not ready for review.', 409);
    if (!reviewerIds.includes(actorId)) return fail('Only the assigned indent reviewer can mark this indent correct.');
    if (actorId === row.created_by) return fail('The raiser cannot also review this indent. Assign another reviewer in Workflow Settings.');
  } else {
    if (!pendingRaiser) return fail('The indent must be marked correct before the raiser can approve it.', 409);
    if (actorId !== row.created_by) return fail('Only the user who raised this indent can give final approval.');
    if (row.l1_by === actorId) return fail('Reviewer and final approver must be different users.');
  }
  // Changes must be saved and reviewed first, never slipped into final approval.
  const forbidden = body.status === 'reviewed' ? ['quantity_overrides', 'unit_overrides', 'store_qty_per_item'] : ['quantity_overrides', 'unit_overrides'];
  if (forbidden.some(k => body[k] && Object.keys(body[k]).length)) return fail('Save corrections using Edit, then have them reviewed before approval.', 400);
  return null;
}

function markCorrect(db, row, actorId) {
  db.transaction(() => {
    db.prepare("UPDATE indents SET status='l1_approved', l1_status='approved', l1_by=?, l1_at=CURRENT_TIMESTAMP, l2_status='pending' WHERE id=?").run(actorId, row.id);
    audit(db, row, actorId, 'marked_correct', { items: db.prepare('SELECT * FROM indent_items WHERE indent_id=?').all(row.id) });
    db.prepare(`INSERT INTO notifications (user_id,type,title,body,link_url,channel_sent,dedupe_key)
      VALUES (?,'approval_pending',?,?,?,?,?)`).run(row.created_by, `Approve indent ${row.indent_number}`,
      'Your indent has been checked and marked correct. Review the items and give final approval.',
      `/procurement?approve=${row.id}`, 'in_app', `indent-raiser:${row.id}:${row.review_revision}`);
  })();
}

function invalidateReview(db, row, actorId) {
  if (!usesRaiserApproval(row)) return;
  audit(db, row, actorId, 'edited_review_invalidated', { previous_status: row.status, reviewed_by: row.l1_by });
  db.prepare(`UPDATE indents SET review_revision=review_revision+1,
    status=CASE WHEN crm_status='approved' THEN 'crm_approved' ELSE 'submitted' END,
    l1_status='pending', l1_by=NULL, l1_at=NULL, l2_status='pending', l2_by=NULL, l2_at=NULL,
    approved_by=NULL, approved_at=NULL, rejected_by=NULL, rejected_at=NULL, rejection_reason=NULL WHERE id=?`).run(row.id);
}

module.exports = { START_DATE, appliesOn, usesRaiserApproval, migrate, audit, validateAction, markCorrect, invalidateReview };
