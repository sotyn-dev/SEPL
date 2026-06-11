---
name: scope-a-feature
description: Interactively scope a new feature before writing any code. Trigger when the user says "I want to add a feature", "let's build a feature", or otherwise proposes a new feature to design. Asks sharp clarifying questions, surfaces edge cases, suggests adjacent ideas, restates the plan, then waits for explicit approval before implementing.
---

# scope-a-feature

Goal: turn a vague feature idea into an approved, implementable plan. Do NOT write or edit code until the user approves the restated plan.

## Steps

1. **Clarify** — Read the feature request. Use `AskUserQuestion` (one batch, 3–4 questions max) covering whichever of these are unclear:
   - **Who/where**: which user role, which screen/module (CRM, indent, PO/FOC, HR, etc.), trigger point
   - **Inputs & data**: required fields, where data comes from, what gets stored, schema changes
   - **Behavior & edge cases**: empty/zero/duplicate inputs, permissions, validation, what happens on error or partial save
   - **Scope boundary**: what's explicitly OUT of scope for v1
   Skip any dimension the user already specified. Don't ask questions whose answers you can read from the code — check first.

2. **Suggest adjacencies** — In 3–6 short bullets, propose related features or extensions the user may not have considered (e.g., reporting hook, audit log, mobile view, export, approval flow). Frame as options, not commitments.

3. **Wait** — Stop and wait for the user's answers and reactions to suggestions. Do not proceed until they reply.

4. **Restate** — In ONE paragraph (≤6 sentences), restate the agreed plan: what's being built, where it lives, key behaviors, edge cases handled, what's out of scope. End with: *"Approve to build, or tell me what to change."*

5. **Gate** — Only after the user replies with approval ("yes", "approved", "go", "build it", etc.) do you implement. If they ask for changes, loop back to step 3 with a revised restatement.

## Rules

- No code, no file edits, no `Write`/`Edit` calls before approval — exploratory `Read`/`Grep` to ground questions in real code is fine and encouraged.
- Questions must be sharp and specific to THIS feature in THIS codebase. No generic checklists.
- If the user tries to skip ahead ("just build it"), confirm once that they're waiving scoping, then proceed.
