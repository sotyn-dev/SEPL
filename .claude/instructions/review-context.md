# Code Review Context — SEPL ERP Platform

## Project Overview

**SEPL** is a full-stack business ERP platform with ~50+ feature modules. It's a React+Vite frontend SPA communicating with an Express+SQLite backend. Active codebase with heavy business logic, no test infrastructure yet.

- **Deployment**: Render.com (primary), self-hosted VPS option
- **Error tracking**: Sentry (both frontend and backend)
- **Database**: SQLite with better-sqlite3 (no ORM, raw SQL)
- **Users**: Business users (HR, procurement, CRM, billing, inventory teams)

## Architecture

```
SEPL/
├── client/               React SPA (Vite, Tailwind, ~20 modules)
├── server/               Express API (~50 routes across 10+ domains)
└── docs/                 Deployment & architecture docs
```

**Key domains**: HR, procurement (indents/POs), CRM, billing, inventory, FOC (field operations), labour, approvals.

## Critical Security Concerns

- **No test infrastructure** — changes can't be validated via automated tests; manual/staging testing is critical
- **SQLite in production** — single-file database; backup strategy matters; schema migrations must be careful
- **Sentry integration** — errors auto-logged; watch for sensitive data in error messages/stack traces
- **JWT auth** — tokens in Authorization header; no token revocation list yet (future improvement)
- **File uploads** — PDF parsing (pdf-parse), Excel (xlsx), Word (mammoth) — validate file types & sizes before processing
- **Third-party services** — Twilio (SMS/WhatsApp), Nodemailer (email), web-push; API keys in .env (check they're not logged)
- **Raw SQL queries** — better-sqlite3 requires parameterized queries; SQL injection risk if `?` placeholders not used
- **CORS** — check frontend <> backend communication is properly scoped (not overly permissive)

## Common Patterns & Anti-Patterns

### Frontend (React)
- **Component organization**: `src/components/` for reusable, `src/pages/` for routes
- **File sizes**: Components <300 LOC, pages <500 LOC (split if larger)
- **Styling**: Tailwind only (no inline CSS)
- **Hooks**: Custom hooks in `src/hooks/` with `use` prefix
- **Error handling**: Error Boundary wrapping page routes, Sentry logging, user toast messages
- **State**: Zustand or context (no prop drilling for global state)

### Backend (Express)
- **Route organization**: Domain-driven folders (`routes/hr/`, `routes/crm/`, etc.)
- **File sizes**: Route handlers <250 LOC (extract logic to `utils/`)
- **Validation**: Always validate input before DB (not after)
- **API responses**: Consistent shape: `{status, data, timestamp}` or `{status, error, details, code, timestamp}`
- **Status codes**: 200, 201, 400, 401, 403, 404, 500 (use correctly)
- **Middleware order**: Auth → validation → handler → error (last)
- **Database access**: Through prepared statements in `server/db/queries/` (not inline in routes)

### Database (SQLite)
- **Query safety**: Parameterized queries ALWAYS (`?` placeholders, never string concatenation)
- **Transactions**: Multi-step mutations (approve + update) must be wrapped
- **Indexes**: Check for N+1 queries; add indexes on frequently filtered columns (`user_id`, `status`, `created_at`)
- **Soft deletes**: Use `deleted_at` column for archival, not destructive deletes
- **Audit logs**: Critical tables (users, indents, approvals) should have audit trail
- **Foreign keys**: Enforced (PRAGMA foreign_keys = ON at init)

### Shared
- **Naming**: camelCase (vars/funcs), PascalCase (components/classes), SCREAMING_SNAKE_CASE (constants)
- **No TypeScript** — plain JS with JSDoc comments only where intent is non-obvious
- **Git**: Commit message format: `[type]: description` (e.g., `fix: add missing indent margin`)
- **Secrets**: Only in `.env`, never in code or logs
- **Error logging**: Always include context (user ID, request path, action) when logging to Sentry

## Known Constraints & Future Work

- **No test infrastructure** — add when testing framework chosen (Jest, Vitest, etc.)
- **No token revocation** — logout clears client token; server-side revocation list TBD
- **No database migrations framework** — migrations are manual SQL files in `server/db/migrations/`
- **No API versioning** — all endpoints use `/api/` base; breaking changes require coordination
- **Limited pagination** — some endpoints may not paginate large result sets; check for memory issues

## What Reviewers Should Prioritize

### Code Review (`/code-review`)
1. **Business logic correctness** — Does the feature do what it's supposed to? (No test suite to catch regressions)
2. **Security vulnerabilities** — SQL injection, XSS, CORS, file upload validation, secret handling
3. **Performance** — N+1 queries, oversized responses, blocking operations
4. **Code quality** — File sizes, naming, reuse of existing utilities, simplification opportunities
5. **Error handling** — Are errors caught? Logged to Sentry? User-friendly messages?

### Security Review (`/security-review`)
1. **SQL injection** — Parameterized queries used consistently
2. **XSS** — React auto-escapes; watch for `dangerouslySetInnerHTML`
3. **CORS & auth** — Authorization headers validated; permissions checked before mutations
4. **Secrets** — No API keys, passwords, or tokens in code or error messages
5. **File uploads** — Type validation, size limits, safe parsing
6. **Third-party services** — Are Twilio, Nodemailer, web-push calls safe? Keys not logged?
7. **Data exposure** — Are sensitive fields (passwords, tokens, PII) filtered from responses?
8. **Dependency vulnerabilities** — Check new npm packages for known issues

## Running Reviews

```bash
# Quick quality check (low effort, high confidence)
/code-review low

# Deep review (more thorough, may include uncertain findings)
/code-review high

# Comprehensive security review
/security-review

# Or chain both for thorough analysis:
/code-review high && /security-review
```

Both reviewers will automatically load the relevant `.claude/rules/` files based on what files changed.

## Red Flags to Watch For

- ❌ String concatenation in SQL queries (SQL injection risk)
- ❌ `dangerouslySetInnerHTML` without explicit sanitization
- ❌ API responses returning unhashed passwords or full tokens
- ❌ File uploads without type/size validation
- ❌ `console.log()` or `debugger` statements left in code
- ❌ `.env` or `.env.local` committed to git
- ❌ New large dependencies without justification
- ❌ Routes handler >250 LOC (too much logic in one place)
- ❌ Missing error handling in try/catch blocks
- ❌ API responses with inconsistent structure
- ❌ Sentry logging sensitive user data (full error stacks, request bodies)

## When to Escalate

- Potential security vulnerability (even if uncertain) → `/security-review` + manual code inspection
- Significant architecture change (new major package, new pattern) → Discuss with team before merging
- Database schema changes → Review migration strategy carefully (no easy rollback in production SQLite)
- Changes to auth/permissions logic → Security review + functional testing on staging
