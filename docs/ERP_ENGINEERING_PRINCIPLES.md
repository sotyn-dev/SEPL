# CLAUDE.md

# ERP Engineering Principles

This document is the architectural contract for all contributors and AI coding agents.

## 1. Product Before Code
- Understand the business workflow before writing code.
- Implementation must follow the approved specification.
- If implementation and specification conflict, stop and raise the mismatch.
- Never invent business requirements.

---

## 2. Think Before Coding
For every major feature:
1. Understand the business problem.
2. Define the expected user experience.
3. Review architecture.
4. Identify risks and open questions.
5. Freeze the implementation plan.
6. Implement in phases.
7. Verify implementation against the approved plan.

Never skip architecture review.

---

## 3. Single Source of Truth
Business rules must exist in one place only.

Never duplicate:
- Validation
- Business rules
- Status definitions
- Permissions
- Workflow logic
- Field mappings
- Section definitions

UI consumes business rules. It never recreates them.

---

## 4. Build Business Modules
Organize the ERP into business modules, not technical layers.

Examples:
- HR
- Payroll
- Attendance
- Leave
- Assets
- Procurement
- Finance

Modules should be loosely coupled and reusable.

---

## 5. DRY
Never copy business logic.

Extract reusable:
- Components
- Hooks
- Utilities
- Services
- Validation
- API helpers

Reuse before creating new code.

---

## 6. Separation of Concerns
Each layer has one responsibility.

Frontend
- UI
- User interaction

API
- Request orchestration

Business Layer
- Rules
- Validation
- Workflow

Database
- Persistence

Do not mix responsibilities.

---

## 7. Pure Business Logic
Calculation functions must be pure.

They should never:
- Write database
- Update state
- Write history
- Trigger workflow

Business actions should consume calculation functions.

---

## 8. Workspace Philosophy
Complex entities should be Workspaces.

Example:

Employee Workspace
- Overview
- Employment
- Personal
- Compensation
- Compliance
- Documents
- Timeline

One entity.
Multiple logical sections.
One source of truth.

---

## 9. Timeline
Timeline is an immutable business event log.

Record:
- What changed
- Who changed it
- Why
- When

Business logic creates Timeline.
Timeline never drives business logic.

---

## 10. Validation
Separate:
- Field validity
- Business completeness

A valid field may still be optional.

Business actions (Activate, Approve, Release, etc.) decide completeness.

---

## 11. State Machines
Prefer explicit states over multiple boolean flags.

Examples:
Draft → Active → Confirmed → Archived

Business behavior should follow state transitions.

---

## 12. APIs Represent Business Actions
Prefer business endpoints over CRUD.

Examples:
Create Employee
Activate Employee
Approve Payment
Reject Leave
Generate Payroll

Avoid exposing database design through APIs.

---

## 13. Frontend
Build reusable, composable UI.

Prefer:
- Small components
- Shared layouts
- Shared controls
- Shared hooks
- Shared utilities

Reuse existing implementation whenever practical.

---

## 14. Database
Keep one source of truth.

Avoid duplicated or derived data unless required for performance.

Every schema change must include migration considerations.

---

## 15. Backward Compatibility
Before changing existing functionality, review:
- Existing data
- APIs
- Reports
- Timeline
- Permissions
- Existing workflows

Never introduce silent regressions.

---

## 16. Performance
Measure before optimizing.

Optimize only where needed:
- Queries
- Rendering
- Network
- Large datasets

Avoid premature optimization.

---

## 17. Documentation
Every significant feature should document:
- Business purpose
- Architecture
- UI changes
- API changes
- Database changes
- Migration notes
- Known limitations

---