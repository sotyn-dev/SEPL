const bcrypt = require('bcryptjs');

function usernameBase(name) {
  return String(name || '').normalize('NFKC').trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '.').replace(/^\.+|\.+$/g, '').slice(0, 80).replace(/\.+$/g, '') || 'employee';
}
// Must be called inside the employee creation transaction. Existing accounts
// are linked without changing their password, activation or permissions.
function provisionEmployeeLogin(db, { name, email, phone, department, userId }) {
  let existing;
  if (userId) existing = db.prepare('SELECT id,username FROM users WHERE id=?').get(userId);
  else if (email?.trim()) existing = db.prepare('SELECT id,username FROM users WHERE LOWER(email)=LOWER(?)').get(email.trim());
  if (existing) return { userId: existing.id, username: existing.username, created: false };
  if (userId) throw new Error('Linked login user does not exist');
  const base = usernameBase(name);
  let username = base, suffix = 1;
  while (db.prepare('SELECT id FROM users WHERE LOWER(username)=LOWER(?) OR LOWER(email)=LOWER(?) OR LOWER(email)=LOWER(?)').get(username, username, `${username}@employee.invalid`)) username = `${base}.${++suffix}`;
  // users.email is NOT NULL in the legacy schema. The reserved .invalid
  // address is an internal placeholder only; employees.email stays empty.
  const loginEmail = email?.trim() || `${username}@employee.invalid`;
  const id = Number(db.prepare('INSERT INTO users(name,email,username,password,role,department,phone,active,must_change_password) VALUES(?,?,?,?,?,?,?,?,1)')
    .run(name.trim(), loginEmail, username, bcrypt.hashSync('123456', 10), 'user', department || null, phone || null, 1).lastInsertRowid);
  return { userId: id, username, created: true, initial_password: '123456', requires_password_change: true };
}
module.exports = { provisionEmployeeLogin, usernameBase };
