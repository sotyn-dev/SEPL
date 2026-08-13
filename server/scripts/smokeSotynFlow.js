// SOTYN Flow API smoke test. Mints tokens for real users via the server's own
// generateToken (same JWT secret), then exercises the /api/sotyn-flow routes
// against a locally running server (default 127.0.0.1:5000). Node >=18 (fetch).
//   1) start the server:  node server/index.js
//   2) run this script:    node server/scripts/smokeSotynFlow.js
const { getDb } = require('../db/schema');
const { getBoardDb } = require('../db/sotynFlowDb');
const { generateToken } = require('../middleware/auth');

const BASE = process.env.FLOW_BASE || 'http://127.0.0.1:5000/api/sotyn-flow';
const db = getDb();
const fdb = getBoardDb();   // separate board DB — proves isolation from erp.db
const uget = (id) => db.prepare('SELECT id,email,role,name FROM users WHERE id=?').get(id);
const A = generateToken(uget(1));   // app admin (super-viewer)
const M = generateToken(uget(3));   // plain user 'Test Member'
const U2 = 2;                        // Backup Admin — used as a non-board-member

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗ FAIL:', msg); } };

async function call(method, path, token, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

(async () => {
  console.log('SOTYN Flow smoke test →', BASE);

  console.log('\nA. Auth gate');
  ok((await call('GET', '/', null)).status === 401, 'GET / with no token → 401');

  console.log('\nB. Create + seed');
  const c = await call('POST', '/', A, { name: 'Smoke Board', description: 'desc', member_ids: [3] });
  ok(c.status === 200 && c.data.id, 'admin creates board → 200');
  const bid = c.data.id;
  const g = await call('GET', `/${bid}`, A);
  const colTitles = (g.data.columns || []).map(x => x.title);
  ok(colTitles.join(',') === 'To Do,In Progress,Done', 'seeded 3 columns To Do/In Progress/Done');
  ok(g.data.board.my_role === 'admin', 'creator my_role = admin');
  const creator = g.data.members.find(m => m.user_id === 1);
  const mem3 = g.data.members.find(m => m.user_id === 3);
  ok(creator?.role === 'admin' && mem3?.role === 'member', 'creator=admin, added member=member');

  console.log('\nC. Create gating + access control + super-viewer');
  ok((await call('POST', '/', M, { name: 'nope' })).status === 403, 'plain user WITHOUT create permission → 403 (creation gated)');
  ok((await call('GET', `/${bid}`, M)).status === 200, 'member can GET board they belong to');
  // A board the admin is NOT a member of — inserted directly so we can prove see-all.
  const bidX = fdb.prepare("INSERT INTO boards (name, created_by, created_by_name, labels) VALUES ('Foreign board', 2, 'Backup Admin', '[]')").run().lastInsertRowid;
  fdb.prepare("INSERT INTO board_members (board_id, user_id, user_name, role) VALUES (?,?,?, 'admin')").run(bidX, 2, 'Backup Admin');
  ok((await call('GET', `/${bidX}`, A)).status === 200, 'super-viewer (admin) opens a board they are NOT a member of');
  const listA = await call('GET', '/', A);
  ok(listA.data.can_see_all === true, 'admin response can_see_all=true');
  ok(listA.data.boards.some(b => b.id === bidX), 'admin (see-all) lists a non-member board');
  const listAmine = await call('GET', '/?mine=1', A);
  ok(!listAmine.data.boards.some(b => b.id === bidX), '?mine=1 hides the non-member board');
  const listM = await call('GET', '/', M);
  ok(listM.data.can_see_all === false, 'plain user can_see_all=false');
  ok(!listM.data.boards.some(b => b.id === bidX), 'plain user does NOT see a board they are not a member of');

  console.log('\nD. Board-admin gating (M is member, not board-admin, of Smoke Board)');
  ok((await call('PUT', `/${bid}`, M, { name: 'hack' })).status === 403, 'member cannot edit board → 403');
  ok((await call('POST', `/${bid}/members`, M, { user_ids: [2] })).status === 403, 'member cannot add members → 403');
  ok((await call('POST', `/${bid}/columns`, M, { title: 'x' })).status === 403, 'member cannot add column → 403');
  ok((await call('DELETE', `/${bid}`, M)).status === 403, 'member cannot delete board → 403');

  console.log('\nE. Cards (member actions) + activity');
  const colTodo = g.data.columns[0].id, colDoing = g.data.columns[1].id;
  const card = await call('POST', `/${bid}/cards`, M, { column_id: colTodo, title: 'Card One' });
  ok(card.status === 200 && card.data.id, 'member creates a card → 200');
  const cardId = card.data.id;
  ok((await call('POST', `/${bid}/cards`, M, { column_id: colTodo, title: '' })).status === 400, 'empty card title → 400');
  ok((await call('PUT', `/${bid}/cards/${cardId}/move`, M, { column_id: colDoing })).status === 200, 'member moves card → 200');
  const asg = await call('POST', `/${bid}/cards/${cardId}/members`, M, { user_ids: [3, U2] });
  ok(asg.data.some(x => x.user_id === 3) && !asg.data.some(x => x.user_id === U2), 'assign board member ok; non-member (u2) rejected');
  ok((await call('POST', `/${bid}/cards/${cardId}/comments`, M, { body: 'hello' })).status === 200, 'member posts a comment → 200');
  ok((await call('POST', `/${bid}/cards/${cardId}/comments`, M, {})).status === 400, 'empty comment → 400');
  const detail = await call('GET', `/${bid}/cards/${cardId}`, M);
  ok(detail.data.activity.some(a => a.type === 'moved') && detail.data.activity.some(a => a.type === 'created'), 'activity log has created + moved');
  ok(detail.data.comments.length === 1, 'comment stored');

  console.log('\nF. Promote / demote + last-admin guard');
  ok((await call('PUT', `/${bid}/members/3/role`, A, { role: 'admin' })).status === 200, 'admin promotes member to board-admin');
  ok((await call('PUT', `/${bid}`, M, { description: 'now I can' })).status === 200, 'promoted user can now manage the board');
  ok((await call('PUT', `/${bid}/members/1/role`, A, { role: 'member' })).status === 200, 'demote first admin (2nd admin remains) → 200');
  ok((await call('PUT', `/${bid}/members/3/role`, M, { role: 'member' })).status === 409, 'cannot demote the LAST board-admin → 409');

  console.log('\nG. Cascade delete');
  ok((await call('DELETE', `/${bid}`, M)).status === 200, 'board-admin deletes board → 200');
  ok([403, 404].includes((await call('GET', `/${bid}`, M)).status), 'deleted board no longer accessible');
  const leftover = fdb.prepare('SELECT COUNT(*) c FROM board_cards WHERE board_id=?').get(bid).c
    + fdb.prepare('SELECT COUNT(*) c FROM board_card_comments WHERE board_id=?').get(bid).c
    + fdb.prepare('SELECT COUNT(*) c FROM board_columns WHERE board_id=?').get(bid).c;
  ok(leftover === 0, 'no orphaned cards/comments/columns after board delete');
  // Isolation proof: board tables must NOT exist in erp.db.
  const inErp = db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name LIKE 'board%'").get().c;
  ok(inErp === 0, 'board_* tables do NOT exist in erp.db (separate database)');
  await call('DELETE', `/${bidX}`, A);   // cleanup

  console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('smoke crashed:', e); process.exit(1); });
