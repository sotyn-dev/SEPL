---
paths: ["server/**/*db*.js", "server/db/**/*"]
description: SQLite & better-sqlite3 conventions
---

# Database Rules (SQLite + better-sqlite3)

## Query Safety

- **Parameterized queries ALWAYS**: Use `?` placeholders, never string concatenation
  ```javascript
  // ✓ Good
  db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  
  // ✗ Bad — SQL injection risk
  db.prepare(`SELECT * FROM users WHERE id = ${userId}`).get();
  ```
- **Prepared statements**: Reuse statements for repeated queries using `.get()`, `.all()`, `.run()`
- **Transactions**: Wrap multi-step mutations in transactions to ensure atomicity

## Query Patterns

- **Selects**: `db.prepare("SELECT ...").get()` or `.all()` depending on cardinality
- **Inserts**: `db.prepare("INSERT INTO ...").run(values)` returns `{changes, lastInsertRowid}`
- **Updates**: `db.prepare("UPDATE ... WHERE id = ?").run(value, id)` returns `{changes}`
- **Deletes**: `db.prepare("DELETE FROM ... WHERE id = ?").run(id)` returns `{changes}`

## Schema & Migrations

- **Migrations** in `server/db/migrations/` (one file per schema change, numbered: `001_init.sql`, `002_add_column.sql`)
- **Schema file** at `server/db/schema.sql` — source of truth, auto-generated from migrations or maintained manually
- **Foreign keys** enforced (PRAGMA foreign_keys = ON at connection init)
- **Constraints**: NOT NULL, UNIQUE, CHECK on columns; cascading deletes where appropriate

## Data Integrity

- **Timestamps**: Every table has `created_at` (insert-only), `updated_at` (trigger on update)
- **Soft deletes**: Add `deleted_at` column if rows should be archived, not destroyed
- **Audits**: Critical tables (users, indents, POs) should have audit log table tracking changes
- **Validation**: Check data type and length in app before INSERT/UPDATE (DB constraints as safety net)

## Connection & Pool

- **Single connection**: better-sqlite3 uses one thread; no connection pooling needed
- **Init**: `db.pragma('foreign_keys = ON')` at startup
- **Backups**: Regular SQLite backups to S3 or same-machine location (handle separately in deployment)

## Performance

- **Indexes**: Add on frequently filtered columns (`user_id`, `status`, `created_at` ranges)
- **No N+1**: Load related data with JOIN or batch queries, not per-row
- **Batch operations**: Use transactions with `INSERT INTO ... VALUES (?, ?), (?, ?) ...` for bulk inserts
- **Explain**: Run `EXPLAIN QUERY PLAN` on slow queries to find missing indexes

## File Organization

- `server/db/init.js` — Connection setup, schema loading
- `server/db/queries/` — Query modules by domain (e.g., `queries/hr.js`, `queries/crm.js`)
- `server/db/migrations/` — Schema migrations (numbered)
- `server/db/schema.sql` — Full schema (reference/restore)
