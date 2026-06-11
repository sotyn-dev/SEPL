---
name: update-rules
description: Extract new patterns from a feature and auto-write rule updates on approval. Trigger with `/update-rules` after building a feature. Scans code, proposes pattern additions, waits for approval, then auto-writes to rule files.
---

# update-rules

Goal: Keep rule files fresh by extracting new patterns from features and auto-updating relevant rule files on your approval.

## Steps

1. **Scan** — Get the diff from the current branch (`git diff main...HEAD` or uncommitted changes if on a branch)
2. **Extract** — Identify new patterns:
   - **Frontend**: New React hook, new component pattern, new Tailwind usage, new accessibility pattern
   - **Backend**: New API endpoint pattern, new error handling, new validation style, new middleware pattern
   - **Database**: New SQL pattern (batch insert, transaction, complex join), new schema pattern
   - **Shared**: New naming pattern, new logging style, new security pattern
3. **Propose** — For each pattern found, format as:
   ```markdown
   **File**: database.md
   **Section**: Query Patterns
   **New pattern**:
   - **Batch insert with transaction**: Wrap multi-row inserts in `db.transaction()` for atomicity
   ```
4. **Wait** — Ask user to approve per rule file:
   - "Approve these updates to frontend.md?" (shows 2-3 bullets)
   - "Approve these updates to backend.md?" (shows bullets)
   - etc.
5. **Write** — On approval, auto-edit each rule file using `Edit` tool, inserting the new pattern under the appropriate section
6. **Commit** — (Optional) User can ask to commit the rule updates: `git commit -m "docs: update rules with [feature-name] patterns"`

## Rules

- **Only new patterns**: Skip variations on existing patterns (e.g., if shared.md already says "camelCase for variables," don't re-add it)
- **No generic/obvious patterns**: Skip "use const instead of var" or "use error handling" — only code-specific insights
- **Terse format**: 1-2 lines per pattern max, with brief code example if it clarifies
- **Section matching**: Insert under the most relevant section in the rule file (e.g., a new hook pattern goes under "React & Hooks")
- **No duplicates**: Check the rule file before proposing — if the pattern is already documented, skip it
- **User discretion**: If user says "no, that's not general enough," respect it — don't force-write

## Example Flow

```
User: "I just built the bulk-approve feature"
You: "Running /update-rules..."
   → Scans client/ and server/ changes
   → Finds:
     1. New React hook: useApprovalWorkflow (fetches list, handles approve/reject)
     2. New API pattern: Batch validation before mutation
     3. New SQL: Transaction wrapping multi-row update

You: "Found 3 new patterns. Approve updates to:
  □ frontend.md: New 'useApprovalWorkflow' hook pattern
  □ backend.md: New 'Validate batch before mutate' pattern
  □ database.md: New 'Transaction wrapping' pattern
  
  Approve all? Y/N per file"

User: "approve frontend and database, skip backend (existing pattern)"

You: [Edit frontend.md] [Edit database.md]
You: "Updated 2 rule files. Commit? (git commit -m 'docs: update rules with bulk-approve patterns')"

User: "yes"

You: [Commits]
```

## Non-negotiables

- **No auto-commit**: Always ask before committing rule updates
- **Show before writing**: Show the exact text to be added and wait for approval before `Edit`/`Write`
- **Reuse existing sections**: Don't create new sections — add under relevant existing headers
- **Preserve formatting**: Maintain the existing Markdown style (bullet lists, code blocks, etc.) when inserting
