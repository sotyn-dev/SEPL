// Who may see which complaints — ONE definition, shared by every route that
// reads the complaints table (mam 2026-08-20: "if i use in complaints view than
// user can show which they assign").
//
// Plain View = only the complaints that are this person's: assigned to them at
// either step, or raised by them. Ticking "See All" on Complaints in the role
// matrix returns the full list, and admin always sees everything.
//
// It lives in lib/ rather than inside complaints.js because complaint rows are
// also served from other routers (installation.js), and a scope that only one
// of them applies is not a scope at all.
//
// Steps 1/2 assignees and emp_name are free TEXT names, so the user's own name
// is matched alongside the id columns — otherwise every complaint assigned by
// name before the picker existed would vanish from that person's list.
const { getUserPermissions } = require('../middleware/auth');

function complaintScope(req, alias = 'c') {
  try {
    if (req.user?.role === 'admin') return null;
    if (getUserPermissions(req.user.id)['complaints']?.can_see_all) return null;
  } catch (_) { /* fall through to the narrow, safe scope */ }
  const a = alias;
  const name = String(req.user?.name || '').trim();
  // An UNTRIAGED complaint is nobody's yet — nothing points at any user, and a
  // public-form complaint has no created_by either. Without this it matched no
  // one's scope, so the "Step 1 — Assign" queue read 0 for every non-admin and a
  // complaint filed by a client was invisible to the very coordinator whose job
  // is to assign it. Untouched complaints therefore stay in the shared pool
  // until someone is put on them.
  return {
    sql: ` AND ((${a}.assigned_to IS NULL AND ${a}.assigned_engineer_id IS NULL
                 AND COALESCE(TRIM(${a}.step1_assigned_to),'') = ''
                 AND COALESCE(TRIM(${a}.step2_assigned_to),'') = '')
                OR ${a}.assigned_to = ? OR ${a}.assigned_engineer_id = ? OR ${a}.created_by = ?
                OR (? <> '' AND (LOWER(TRIM(COALESCE(${a}.step1_assigned_to,''))) = LOWER(?)
                              OR LOWER(TRIM(COALESCE(${a}.step2_assigned_to,''))) = LOWER(?)
                              OR LOWER(TRIM(COALESCE(${a}.emp_name,''))) = LOWER(?))))`,
    params: [req.user.id, req.user.id, req.user.id, name, name, name, name],
  };
}

module.exports = { complaintScope };
