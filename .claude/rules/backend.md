---
paths: ["server/**/*", "!server/db/**/*"]
description: Backend conventions for Express API
---

# Backend Rules (Express + Node.js)

## Route Organization

- **Folder structure**: `routes/` organized by domain (e.g., `routes/hr/`, `routes/procurement/`, `routes/crm/`)
- **File naming**: `<resource>.js` (e.g., `employees.js`, `indents.js`)
- **Route naming**: `GET /api/<domain>/<resource>`, `POST /api/<domain>/<resource>`, etc.
- **File size**: Route handlers <250 LOC — extract business logic to `utils/` or `services/`

## Express Middleware & Structure

- **Order matters**: auth middleware first, then validation, then route handler
- **Error middleware**: Last middleware in stack; catches all errors and formats response
- **Request/response**: Always validate input before passing to DB
- **Status codes**: 200 (success), 201 (created), 400 (validation error), 401 (auth), 403 (forbidden), 404 (not found), 500 (server error)

## API Response Format

All responses (success or error) follow this shape:

**Success:**
```json
{
  "status": "success",
  "data": { ... },
  "timestamp": "2026-06-10T10:30:00Z"
}
```

**Error:**
```json
{
  "status": "error",
  "error": "Validation failed",
  "details": "Field 'email' is required",
  "code": "VALIDATION_ERROR",
  "timestamp": "2026-06-10T10:30:00Z"
}
```

## Input Validation

- **Before DB**: Always validate and sanitize input at the route handler level
- **Type checking**: Ensure fields match expected types (number, string, array, etc.)
- **Required fields**: Check presence before DB query
- **SQL injection**: Use parameterized queries (never string concatenation) — handled in `database.md`

## Error Handling

- Wrap all DB queries in try/catch
- Log errors to Sentry with context (user ID, request path, method)
- Return user-friendly error messages (not stack traces)
- HTTP error responses with appropriate status codes (400, 401, 403, 500)

## Authentication & Authorization

- **JWT tokens** in Authorization header: `Authorization: Bearer <token>`
- **Middleware**: `authMiddleware` verifies token before route handler
- **Permissions**: Check user role/permissions before mutating data
- **Logout**: Clear token on client; token expiry on server (no revocation list yet)

## File Organization

- `routes/<domain>/*.js` — API endpoints
- `utils/<domain>/*.js` — Business logic, helper functions
- `middleware/*.js` — Auth, validation, error handling
- `db/*.js` — Database queries (see `database.md`)
