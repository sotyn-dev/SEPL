# SEPL — Business ERP Platform

**Full-stack SPA:** React+Vite frontend, Express+SQLite backend.

## Quick Start

```bash
npm run dev          # Start both frontend (3000) and backend (5000)
npm run build        # Build frontend
npm run start:prod   # Run server in production
```

## Project Structure

- **`client/`** — React SPA (Vite, Tailwind, ~20+ feature modules)
- **`server/`** — Express API (SQLite, ~50+ business logic routes)
- **`docs/`** — Documentation and deployment guides

## Code Conventions

Modular rules by subsystem — Claude loads automatically when editing:
- **Frontend rules** → `.claude/rules/frontend.md` (React/Vite/Tailwind)
- **Backend rules** → `.claude/rules/backend.md` (Express API)
- **Database rules** → `.claude/rules/database.md` (SQLite/better-sqlite3)
- **Shared rules** → `.claude/rules/shared.md` (naming, git, error handling)

See `.claude/rules/` for detailed conventions. Update rules as features grow using `/update-rules` skill.

## Deployment

- **Render.com** → `render.yaml` (primary)
- **Self-hosted VPS** → `deploy-vps.sh`
- **Error tracking** → Sentry (frontend + backend)

## Testing

No test infrastructure configured yet. Add when framework is chosen.

## Branching
- ALWAYS create a feature branch before starting major changes
- NEVER commit directly to `main`
- Branch naming: `feature/description` or `fix/description`

## Git workflow for major changes
1. Create a new branch: `git checkout -b feature/your-feature-name`
2. Develop and commit on the feature branch