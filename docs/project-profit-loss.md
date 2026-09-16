# Project profit and loss

Finance > Project Profit & Loss (`/project-profit`). A provisional management report, not a statutory financial statement. Matching project names are consolidated across Business Book orders (Unicode normalization, case-insensitive, trimmed/collapsed whitespace). Company name is used only when project name is blank. No fuzzy matching. Amounts sum across orders; margin is recalculated from combined revenue and cost. Review retains each original order, and manual entries must be assigned to an included order.

## Calculation basis

- Sales invoices (default): approved type 2 / 3 and approved legacy invoices, amount before GST. Type 1 sales orders and type 4 final summaries are excluded to prevent contract duplication.
- Client RA: gross amounts from non-cancelled client RA records; not added to sales invoices.
- DPR: approved, submitted, non-template DPR work value A and cost B. No bills or payments added to this basis.
- For sales / client RA, costs comprise purchase bill amounts before GST via vendor PO > indent > planning > Business Book, non-cancelled contractor RA gross amounts, and final-approved TA/DA or Transport requests linked via site. Purchase/Labour payment requests are excluded to avoid duplicating bill costs. RA and request amounts are used as recorded; tax treatment and source overlaps need review.
- Manual signed adjustments are basis-specific. Negative costs reverse costs; negative revenue reduces revenue. Date and reason are required. Adjustments cannot be silently edited or deleted: voiding preserves actor, timestamp and reason; replacement is a new entry.
- Profit = automatic revenue + manual revenue - automatic cost - manual cost. Margin is undefined when revenue is zero or negative.
- Contract value is Business Book sale less management discount, separate from revenue and independent of date filters.

## Data completeness

Automatic coverage depends on linked and approved source records, not a fixed 80% formula. Missing overhead, payroll, tax corrections and other gaps are manual. Standalone solar projects not linked to Business Book are not consolidated here. Unlinked and undated source entries are flagged; undated entries are excluded from dated periods. No-activity projects show a dash instead of a profit conclusion. All values are in INR.

Date filters: bill date, RA raised date, request created date, DPR report date, manual entry date. Refresh on page load, filter change or Refresh; source records are never modified by this report.

## Access and deployment

New `project_profit` module: view for financial totals, create for manual adjustments, delete for voiding. Admin receives access through existing seed logic. Existing non-admin roles remain denied until explicitly granted. The additive `project_profit_adjustments` table is initialized on server startup; no existing financial data is rewritten. Local preview uses an isolated database copy.

## Validation

`node --test server/lib/__tests__/projectProfit.test.js`: arithmetic, duplicate invoice exclusions, multiple site links, separate bases, signed adjustments, date filtering, missing links, input validation, route permission gates and void history. Frontend scoped ESLint and Vite build. Local browser review includes saving and voiding an explicitly labelled QA adjustment.
