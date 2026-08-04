# AGENTS.md

# ERP Engineering Guidelines

This is a long-lived enterprise ERP. Prioritize maintainability, consistency and extensibility over quick implementation.

## Core Principles

- Reuse existing architecture before introducing new patterns.
- Extend modules; do not rewrite working implementations.
- DRY over duplication.
- Business rules belong on the server.
- UI renders state; it should not duplicate business logic.
- One source of truth for every rule.
- Prefer composition over copy-paste.
- Keep modules loosely coupled.

## Employee Workspace

Every new module must follow the established chain:

Registry
→ Schema
→ Validation
→ Routes
→ Sections
→ Workspace UI

Do not invent a different implementation flow.

## Workspace Philosophy

Employee Workspace is an editing workspace, not a dashboard.

- Minimize clicks.
- Minimize cognitive load.
- Prefer consistency over novelty.
- Reuse interaction patterns.
- Avoid unnecessary dialogs.
- Avoid widget-style layouts.
- Avoid long flat forms.

Before implementation define:

1. Business grouping
2. Visual hierarchy
3. Interaction pattern
4. Future extensibility

## Backend

- Keep APIs generic.
- Prefer partial PUT updates.
- Validation belongs on the server.
- Never duplicate validation rules in React.
- Maintain backward compatibility whenever possible.
- One transaction per business operation.
- Preserve audit history.

## Timeline

Timeline is the audit ledger.

Do not bypass it.

Every tracked change must flow through the existing history mechanism.

## Permissions

Reuse existing permission model.

Do not create new permissions unless absolutely necessary.

## UI

Think like an HR user, not a database.

Group by business concepts.

Never expose database structure directly.

Keep forms compact.

Progressive disclosure for advanced or sensitive actions.

## Sensitive Fields

Sensitive identifiers use one reusable interaction:

Default:
Masked value + Change button

On Change:
Reveal editor inline

Cancel:
Reset temporary value and return to read-only state.

## Documents

Documents are stored once.

Business modules may show document status and contextual actions.

Never duplicate document storage.

## Before Coding

Always perform:

- Specification coverage review
- Existing implementation review
- Reuse analysis

Prefer extending existing components over creating new ones.

## When Unsure

Stop and explain trade-offs before implementing.

## Implementation Discipline

Do not continue refining one area while other specification items remain unimplemented.

Before polishing UI:

- Verify 100% specification coverage.
- Produce a coverage matrix.
- Identify missing fields/modules.
- Then continue implementation.