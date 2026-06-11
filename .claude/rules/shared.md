---
paths: ["**/*"]
description: Shared conventions across frontend and backend
---

# Shared Rules (Naming, Git, Error Handling)

## Naming Conventions

- **Variables & functions**: `camelCase` (e.g., `getUserById`, `isFormValid`)
- **Components & classes**: `PascalCase` (e.g., `UserForm`, `DatabaseConnection`)
- **Constants**: `SCREAMING_SNAKE_CASE` (e.g., `MAX_RETRY_ATTEMPTS`, `DEFAULT_TIMEOUT_MS`)
- **File names**: 
  - Components: `PascalCase.jsx` (e.g., `Button.jsx`, `UserProfile.jsx`)
  - Utilities/modules: `camelCase.js` (e.g., `auth.js`, `formatDate.js`)
  - Config: `lowercase.js` (e.g., `config.js`, `database.js`)

## No TypeScript — Comments for Clarity

- **No TS types** — project uses plain JavaScript
- **JSDoc comments** only when type intent is non-obvious or affects callers:
  ```javascript
  // ✓ Good: Clarifies unexpected behavior
  function calculateMargin(cost, sellingPrice) {
    // Returns margin as percentage (0-100), not decimal
    return ((sellingPrice - cost) / sellingPrice) * 100;
  }
  
  // ✗ Skip: Variable names already explain purpose
  // const users = []; // Array of users
  ```
- **No multi-line docstring blocks** — keep comments to 1-2 lines max

## Git Conventions

- **Commit messages**: `[type]: brief description` (e.g., `fix: add missing indent margin`, `feat: bulk approve flow`)
  - Types: `fix:`, `feat:`, `refactor:`, `docs:`, `test:`
- **Branch naming**: `feature/<name>`, `fix/<name>`, `refactor/<name>` (kebab-case)
- **PR titles**: Same as commit message format; include context in description if needed

## Error Handling

- **Frontend**: Catch errors at component level (Error Boundary), log to Sentry, show toast message to user
- **Backend**: Catch in try/catch, log to Sentry with context, return formatted error response (see backend.md)
- **Sentry integration**: Both apps send errors with `userId`, request path, method, and error stack

## Environment Variables

- **Source of truth**: `.env.example` (committed, lists all required vars with placeholder values)
- **Local override**: `.env` (git-ignored, never committed)
- **Access**: 
  - Frontend: `import.meta.env.VITE_*` (Vite prefixes)
  - Backend: `process.env.VAR_NAME`
- **Missing vars**: App should fail early on startup if required vars are not set

## Logging

- **Console output**: Use for dev/debugging only; remove before commit
- **Production logs**: Errors logged to Sentry automatically
- **Structured logging**: If adding new logging (future), include context object: `{userId, action, timestamp, details}`

## Performance & Size Thresholds

- **Frontend build**: < 500 KB gzipped (monitor with `npm run build`)
- **API responses**: < 5 MB (paginate large datasets)
- **Database queries**: < 5 seconds (add indexes if slower)
- **Component render**: < 100 ms (use React DevTools Profiler to debug)

## Security Basics

- **No secrets in code**: Use environment variables for API keys, JWT secrets
- **Input sanitization**: Validate on frontend (UX), validate on backend (security)
- **SQL injection**: Parameterized queries always (see database.md)
- **XSS prevention**: React auto-escapes by default; use `dangerouslySetInnerHTML` only if trusted content
