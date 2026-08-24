#!/usr/bin/env node
/**
 * incident-restore.js — find rows that exist in a backup but are gone from the
 * live database, and put them back.
 *
 * Built 2026-08-24 alongside incident-forensics.js. Forensics tells you WHAT was
 * deleted; this brings the contents back, because audit_log records that a
 * delete happened but not the row itself.
 *
 * SAFE BY DEFAULT. With no --apply it only ever READS and prints what it would
 * do. --apply copies the live database to a timestamped .before-restore file
 * first, then inserts inside a single transaction: it either all lands or
 * nothing does.
 *
 * TWO MODES:
 *
 * 1. Plain diff (default) — every row present in the backup but absent from
 *    live, regardless of when or why it went missing. Good for a first look,
 *    but it cannot tell an attacker's deletion apart from someone's ordinary,
 *    legitimate cleanup that happens to predate the backup.
 *
 * 2. --deleted-since / --deleted-until (audit-scoped, RECOMMENDED for an
 *    incident) — restores ONLY rows the LIVE audit_log actually recorded as
 *    deleted inside that exact window, resolved from the real request PATH
 *    against a hand-verified table map (TABLE_RULES below) — not the audit
 *    log's generic module label, which is too coarse (e.g. every /api/hr/*
 *    delete is logged as entity_type='hr' whether it deleted an employee, a
 *    candidate, or a checklist). A path that doesn't match a verified rule is
 *    reported as unmapped rather than guessed, so nothing is silently
 *    restored into the wrong table and nothing real is silently skipped.
 *
 *    Deleting a parent row commonly CASCADES into child tables keyed by a
 *    foreign key, not by their own primary key — and some children have
 *    grandchildren of their own (e.g. Business Book -> sites -> DPR -> DPR
 *    line items, three hops deep). TABLE_RULES encodes this as an ordered
 *    chain per route (see the comment above TABLE_RULES), so a cascade is
 *    walked and restored to its full depth, not just the top-level row.
 *
 * Usage (on the VPS):
 *   # audit-scoped: only what was actually deleted in this window
 *   node server/scripts/incident-restore.js --backup <file> \
 *       --deleted-since "2026-08-22 00:00:00" --deleted-until "2026-08-23 23:59:59"
 *
 *   # then apply once the plan looks right
 *   node server/scripts/incident-restore.js --backup <file> \
 *       --deleted-since "..." --deleted-until "..." --apply
 *
 *   # plain diff — what is missing, across every table
 *   node server/scripts/incident-restore.js --backup ~/erp-backups/erp-2026-08-23_02-00-00.db
 *
 *   # look at the actual rows for one table before deciding
 *   node server/scripts/incident-restore.js --backup <file> --table indents --show
 *
 *   # plain-diff apply — one table, or specific records
 *   node server/scripts/incident-restore.js --backup <file> --table indents --apply
 *   node server/scripts/incident-restore.js --backup <file> --table indents --ids 41,42,43 --apply
 *
 * Options:
 *   --backup <path>          REQUIRED. The backup to recover from. It only
 *                            needs to be OLDER than the incident window — it
 *                            is never restored wholesale, only the specific
 *                            audit-confirmed rows are pulled from it, so an
 *                            older-than-necessary backup is completely safe.
 *   --live   <path>          Live DB, default ../../data/erp.db
 *   --deleted-since <ts>     Audit-scoped mode: window start, "YYYY-MM-DD" or
 *                            "YYYY-MM-DD HH:MM:SS" (server-local, matches
 *                            audit_log.at)
 *   --deleted-until <ts>     Audit-scoped mode: window end
 *   --table  <name>          Plain-diff mode: restrict to one table (comma
 *                            list for several)
 *   --ids    <list>          Plain-diff mode: only these primary keys (needs
 *                            --table)
 *   --show                   Print the missing rows themselves, not just a
 *                            count
 *   --apply                  Actually write. Without this, nothing is changed.
 *   --min    <n>             Plain-diff mode: ignore tables missing fewer
 *                            than n rows (default 1)
 *
 * READ THIS BEFORE --apply
 * In PLAIN-DIFF mode, a row missing from live is not automatically a row that
 * was destroyed by an attacker — it is equally consistent with an ordinary,
 * legitimate deletion made on purpose at any point before the backup. Prefer
 * --deleted-since/--deleted-until, which restores only what the audit trail
 * actually shows happened inside the incident window.
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// ── verified DELETE-route → table map ───────────────────────────────────────
// Ground truth, not a guess: every entry below was confirmed by reading the
// actual SQL inside that route's handler in this repo on 2026-08-24 — first a
// 9-file hand pass, then a 15-agent sweep of the remaining 46 route files
// (~125 DELETE routes total). The audit log's own `entity_type` is too coarse
// for this — it is just the second URL segment, so EVERY delete under
// /api/hr/* is logged as entity_type='hr' whether it removed an employee, a
// candidate, or a checklist. We resolve from the exact recorded `path`
// instead, matched against `re` below.
//
// `targets` is an ORDERED CHAIN, not a flat table list — deleting a parent row
// commonly cascades into children keyed by a FOREIGN KEY column, not by their
// own primary key, and some of those children have grandchildren of their
// own. Each step:
//   { table, on, from?, as? }
//     table — the SQL table this step restores rows into
//     on    — the column in `table` whose value must match the id set named
//             by `from` (default 'root' — the audit log's entity_id)
//     from  — which named id-set to match against (default 'root')
//     as    — after restoring, remember THIS table's own restored primary-key
//             values under this name, so a later step can chain off them
//             (needed when a grandchild is keyed by the child's own id, not
//             by the original entity_id — e.g. Business Book -> sites ->
//             DPR -> DPR line items)
// Steps are walked and applied in the order written, so a parent always lands
// before the child that references it.
//
// EXCLUDED ON PURPOSE (reported as unmapped rather than guessed):
//   - /api/auth/users/:id — force-delete clears an admin-discovered, DYNAMIC
//     list of FK references across the whole schema (findUserFkReferences in
//     routes/auth.js), not a fixed table list. Needs a manual, reviewed
//     restore, never an automated one.
//   - /api/orders/po/:id — genuinely ambiguous: behaves differently with vs
//     without ?force=1, and which tables it actually touched isn't
//     recoverable from the audit log alone. Restore this one by hand.
//   - Every /api/sotyn-flow/* route — writes to a SEPARATE database file
//     (sotynflow.db), not erp.db. This tool diffs one backup/live pair; it
//     has no way to touch a second database in the same run.
//   - Any route keyed by a COMPOSITE id (two ids in the path, e.g. site-chat
//     group members, Champions team members) — the audit log's entity_id
//     only ever captures ONE trailing numeric segment, so there is no way to
//     recover the second half of the key from the log alone.
//   - /api/payroll/holidays/:date — keyed by a DATE STRING, not a numeric id;
//     entity_id is never numeric for this route so it naturally falls into
//     the "no numeric id" bucket instead of being silently mis-restored.
//
// A path that matches NONE of these rules is reported as unmapped rather than
// guessed — extend this list (verify the real DELETE FROM target first, and
// its WHERE-clause column) before trusting a newly-seen route to auto-restore.
const TABLE_RULES = [
  { re: /^\/api\/tally-bills\/\d+$/, targets: [{ table: 'tally_bills', on: 'id' }] },
  { re: /^\/api\/tally-bills\/\d+\/files\/\d+$/, targets: [{ table: 'tally_bill_files', on: 'id' }] },
  { re: /^\/api\/tally-bills\/\d+\/payments\/\d+$/, targets: [{ table: 'tally_bill_payments', on: 'id' }] },
  { re: /^\/api\/procurement\/vendors\/\d+$/, targets: [{ table: 'vendors', on: 'id' }] },
  { re: /^\/api\/procurement\/vendor-rates\/\d+$/, targets: [{ table: 'vendor_rates', on: 'id' }] },
  { re: /^\/api\/procurement\/indents\/\d+$/, targets: [
    { table: 'indent_tracker', on: 'indent_id' },
    { table: 'indent_items', on: 'indent_id' },
    { table: 'indents', on: 'id' },
  ] },
  { re: /^\/api\/procurement\/vendor-po\/\d+$/, targets: [{ table: 'vendor_pos', on: 'id' }] },
  { re: /^\/api\/procurement\/item-rates\/\d+$/, targets: [{ table: 'indent_item_rates', on: 'id' }] },
  { re: /^\/api\/procurement\/purchase-bills\/\d+$/, targets: [{ table: 'purchase_bills', on: 'id' }] },
  { re: /^\/api\/procurement\/debit-notes\/\d+$/, targets: [{ table: 'debit_notes', on: 'id' }] },
  { re: /^\/api\/procurement\/delivery-notes\/\d+$/, targets: [{ table: 'delivery_notes', on: 'id' }] },
  { re: /^\/api\/procurement\/sales-bills\/\d+$/, targets: [{ table: 'sales_bills', on: 'id' }] },
  { re: /^\/api\/quotations\/\d+$/, targets: [{ table: 'quotations', on: 'id' }] },
  { re: /^\/api\/quotations\/boq\/\d+$/, targets: [
    { table: 'boq_items', on: 'boq_id' },
    { table: 'boq', on: 'id' },
  ] },
  { re: /^\/api\/quotations\/po-foc\/\d+$/, targets: [{ table: 'po_foc_entries', on: 'id' }] },
  { re: /^\/api\/quotations\/labour-rates\/\d+$/, targets: [{ table: 'labour_rates', on: 'id' }] },
  { re: /^\/api\/quotations\/estimates\/\d+$/, targets: [{ table: 'estimate_quotations', on: 'id' }] },
  { re: /^\/api\/auth\/roles\/\d+$/, targets: [{ table: 'roles', on: 'id' }] },
  { re: /^\/api\/hr\/candidates\/\d+$/, targets: [{ table: 'candidates', on: 'id' }] },
  { re: /^\/api\/hr\/employees\/\d+$/, targets: [{ table: 'employees', on: 'id' }] },
  { re: /^\/api\/hr\/sub-contractors\/\d+$/, targets: [{ table: 'sub_contractors', on: 'id' }] },
  { re: /^\/api\/hr\/expenses\/\d+$/, targets: [{ table: 'expenses', on: 'id' }] },
  { re: /^\/api\/hr\/checklists\/\d+$/, targets: [{ table: 'checklists', on: 'id' }] },
  { re: /^\/api\/hr\/hiring-requests\/\d+$/, targets: [{ table: 'hiring_requests', on: 'id' }] },
  { re: /^\/api\/hr\/jd-templates\/\d+$/, targets: [{ table: 'jd_templates', on: 'id' }] },
  { re: /^\/api\/hr\/job-descriptions\/\d+$/, targets: [{ table: 'job_descriptions', on: 'id' }] },
  { re: /^\/api\/hr\/scorecards\/\d+$/, targets: [{ table: 'interview_scorecards', on: 'id' }] },
  { re: /^\/api\/hr\/final-round-questions\/\d+$/, targets: [{ table: 'final_round_questions', on: 'id' }] },
  { re: /^\/api\/hr\/induction\/\d+$/, targets: [{ table: 'induction_items', on: 'id' }] },
  { re: /^\/api\/hr\/training\/videos\/\d+$/, targets: [{ table: 'training_videos', on: 'id' }] },
  { re: /^\/api\/hr\/training\/assignments\/\d+$/, targets: [{ table: 'training_assignments', on: 'id' }] },
  { re: /^\/api\/hr\/screening-questions\/\d+$/, targets: [{ table: 'screening_questions', on: 'id' }] },
  { re: /^\/api\/hr\/docs\/\d+$/, targets: [{ table: 'candidate_docs', on: 'id' }] },
  { re: /^\/api\/payment-required\/\d+$/, targets: [
    { table: 'payment_approvals', on: 'request_id' },
    { table: 'payment_requests', on: 'id' },
  ] },
  { re: /^\/api\/email-rules\/\d+$/, targets: [{ table: 'email_rules', on: 'id' }] },
  { re: /^\/api\/indent-fms\/grn\/\d+$/, targets: [
    { table: 'grn_items', on: 'grn_id' },
    { table: 'grn', on: 'id' },
  ] },
  { re: /^\/api\/pipe-weights\/\d+$/, targets: [{ table: 'pipe_weights', on: 'id' }] },

  // ── from the 46-file sweep, 2026-08-24 ──
  { re: /^\/api\/dpr\/\d+$/, targets: [
    { table: 'dpr_work_items', on: 'dpr_id' },
    { table: 'dpr_manpower', on: 'dpr_id' },
    { table: 'dpr_material', on: 'dpr_id' },
    { table: 'dpr_machinery', on: 'dpr_id' },
    { table: 'dpr', on: 'id' },
  ] },
  { re: /^\/api\/dpr\/sites\/\d+$/, targets: [{ table: 'sites', on: 'id' }] },
  { re: /^\/api\/scoring\/templates\/\d+$/, targets: [
    { table: 'score_kpis', on: 'template_id' },
    { table: 'score_user_template', on: 'template_id' },
    { table: 'score_templates', on: 'id' },
  ] },
  { re: /^\/api\/scoring\/kpis\/\d+$/, targets: [{ table: 'score_kpis', on: 'id' }] },
  { re: /^\/api\/attendance\/geofence\/\d+$/, targets: [{ table: 'geofence_settings', on: 'id' }] },
  { re: /^\/api\/attendance\/leave\/\d+$/, targets: [{ table: 'leave_requests', on: 'id' }] },
  { re: /^\/api\/attendance\/\d+$/, targets: [{ table: 'attendance', on: 'id' }] },
  { re: /^\/api\/orders\/planning\/\d+$/, targets: [{ table: 'order_planning', on: 'id' }] },
  { re: /^\/api\/procurement-schedule\/holidays\/\d+$/, targets: [{ table: 'procurement_holidays', on: 'id' }] },
  { re: /^\/api\/procurement-schedule\/drawing\/\d+$/, targets: [{ table: 'procurement_schedule_drawings', on: 'id' }] },
  { re: /^\/api\/procurement-schedule\/snapshot\/\d+$/, targets: [{ table: 'procurement_schedule_snapshots', on: 'id' }] },
  { re: /^\/api\/indent-labour-payment\/projects\/\d+$/, targets: [
    { table: 'proj_projects', on: 'id' },
    { table: 'proj_salary_entries', on: 'project_id' },
    { table: 'proj_daily_wage_entries', on: 'project_id' },
    { table: 'proj_work_orders', on: 'project_id', as: 'woIds' },
    { table: 'proj_wo_labour', on: 'work_order_id', from: 'woIds' },
  ] },
  { re: /^\/api\/indent-labour-payment\/salary\/\d+$/, targets: [{ table: 'proj_salary_entries', on: 'id' }] },
  { re: /^\/api\/indent-labour-payment\/daily-wages\/\d+$/, targets: [{ table: 'proj_daily_wage_entries', on: 'id' }] },
  { re: /^\/api\/indent-labour-payment\/work-orders\/\d+$/, targets: [
    { table: 'proj_work_orders', on: 'id' },
    { table: 'proj_wo_labour', on: 'work_order_id' },
  ] },
  { re: /^\/api\/indent-labour-payment\/work-orders\/labour\/\d+$/, targets: [{ table: 'proj_wo_labour', on: 'id' }] },
  { re: /^\/api\/indent-labour-payment\/mb\/\d+$/, targets: [
    { table: 'proj_mb_sheets', on: 'id' },
    { table: 'proj_mb_lines', on: 'mb_id' },
  ] },
  { re: /^\/api\/solar\/quotations\/\d+$/, targets: [{ table: 'solar_quotations', on: 'id' }] },
  { re: /^\/api\/solar\/deals\/\d+$/, targets: [
    { table: 'solar_deal_events', on: 'deal_id' },
    { table: 'solar_deals', on: 'id' },
  ] },
  { re: /^\/api\/solar\/projects\/\d+$/, targets: [
    { table: 'solar_project_events', on: 'project_id' },
    { table: 'solar_project_components', on: 'project_id' },
    { table: 'solar_amc_visits', on: 'project_id' },
    { table: 'solar_projects', on: 'id' },
  ] },
  { re: /^\/api\/solar\/components\/\d+$/, targets: [{ table: 'solar_project_components', on: 'id' }] },
  { re: /^\/api\/solar\/amc-visits\/\d+$/, targets: [{ table: 'solar_amc_visits', on: 'id' }] },
  { re: /^\/api\/solar\/materials\/\d+$/, targets: [{ table: 'solar_materials', on: 'id' }] },
  { re: /^\/api\/solar\/labour\/\d+$/, targets: [{ table: 'solar_labour', on: 'id' }] },
  { re: /^\/api\/inventory\/stock\/\d+$/, targets: [{ table: 'stock_balance', on: 'id' }] },
  { re: /^\/api\/collections\/\d+$/, targets: [
    { table: 'collection_follow_ups', on: 'receivable_id' },
    { table: 'receivables', on: 'id' },
  ] },
  { re: /^\/api\/sales-billing\/\d+$/, targets: [{ table: 'sales_bills', on: 'id' }] },
  { re: /^\/api\/sales-funnel\/\d+$/, targets: [
    { table: 'lead_followups', on: 'lead_id' },
    { table: 'sales_funnel_audit', on: 'lead_id' },
    { table: 'sales_funnel_boqs', on: 'funnel_id' },
    { table: 'sales_funnel', on: 'id' },
  ] },
  { re: /^\/api\/hr-system\/hiring-requests\/\d+$/, targets: [{ table: 'hr_hiring_requests', on: 'id' }] },
  { re: /^\/api\/hr-system\/candidates\/\d+$/, targets: [
    { table: 'hr_candidate_activity', on: 'candidate_id' },
    { table: 'hr_interviews', on: 'candidate_id', as: 'interviewIds' },
    { table: 'hr_interview_feedback', on: 'interview_id', from: 'interviewIds' },
    { table: 'hr_offers', on: 'candidate_id' },
    { table: 'hr_onboarding_tasks', on: 'candidate_id' },
    { table: 'hr_candidates', on: 'id' },
  ] },
  { re: /^\/api\/rentals\/properties\/\d+$/, targets: [
    { table: 'rental_payments', on: 'property_id' },
    { table: 'rental_bookings', on: 'property_id' },
    { table: 'rental_rooms', on: 'property_id' },
    { table: 'rental_properties', on: 'id' },
  ] },
  { re: /^\/api\/rentals\/rooms\/\d+$/, targets: [
    { table: 'rental_bookings', on: 'room_id' },
    { table: 'rental_rooms', on: 'id' },
  ] },
  { re: /^\/api\/rentals\/bookings\/\d+$/, targets: [{ table: 'rental_bookings', on: 'id' }] },
  { re: /^\/api\/rentals\/payments\/\d+$/, targets: [{ table: 'rental_payments', on: 'id' }] },
  { re: /^\/api\/rentals\/rent-requests\/\d+$/, targets: [{ table: 'rent_requests', on: 'id' }] },
  { re: /^\/api\/delegations\/\d+$/, targets: [{ table: 'delegations', on: 'id' }] },
  { re: /^\/api\/item-master\/\d+$/, targets: [{ table: 'item_master', on: 'id' }] },
  { re: /^\/api\/cashflow\/entry\/\d+$/, targets: [{ table: 'cash_flow_entries', on: 'id' }] },
  { re: /^\/api\/price-requests\/\d+$/, targets: [{ table: 'price_requests', on: 'id' }] },
  { re: /^\/api\/subcon-hiring\/file\/\d+$/, targets: [{ table: 'subcon_hiring_files', on: 'id' }] },
  { re: /^\/api\/subcon-hiring\/candidate\/\d+$/, targets: [{ table: 'subcon_hiring_candidates', on: 'id' }] },
  { re: /^\/api\/subcon-hiring\/\d+$/, targets: [
    { table: 'subcon_hiring_steps', on: 'hiring_id' },
    { table: 'subcon_hiring_files', on: 'hiring_id' },
    { table: 'subcon_hiring_candidates', on: 'hiring_id' },
    { table: 'subcon_hiring', on: 'id' },
  ] },
  { re: /^\/api\/complaints\/\d+$/, targets: [{ table: 'complaints', on: 'id' }] },
  { re: /^\/api\/labour-quotations\/\d+$/, targets: [{ table: 'labour_quotations', on: 'id' }] },
  { re: /^\/api\/snags\/\d+$/, targets: [{ table: 'snags', on: 'id' }] },
  { re: /^\/api\/business-book\/\d+$/, targets: [
    { table: 'project_finance', on: 'business_book_id' },
    { table: 'po_items', on: 'business_book_id' },
    { table: 'order_planning', on: 'business_book_id' },
    { table: 'sites', on: 'business_book_id', as: 'siteIds' },
    { table: 'dpr', on: 'site_id', from: 'siteIds', as: 'dprIds' },
    { table: 'dpr_work_items', on: 'dpr_id', from: 'dprIds' },
    { table: 'dpr_manpower', on: 'dpr_id', from: 'dprIds' },
    { table: 'dpr_machinery', on: 'dpr_id', from: 'dprIds' },
    { table: 'attendance', on: 'site_id', from: 'siteIds' },
    { table: 'geofence_settings', on: 'site_id', from: 'siteIds' },
    { table: 'purchase_orders', on: 'business_book_id' },
    // receivables EXCLUDED — code-verified no-op: the route's own subquery
    // (SELECT id FROM purchase_orders WHERE business_book_id=id) runs AFTER
    // purchase_orders is already deleted in the same handler, so it matches
    // nothing and this route never actually removes a receivables row.
    { table: 'business_book', on: 'id' },
  ] },
  { re: /^\/api\/influencers\/\d+$/, targets: [{ table: 'influencers', on: 'id' }] },
  { re: /^\/api\/gamification\/teams\/\d+$/, targets: [
    { table: 'gam_team_member', on: 'team_id' },
    { table: 'gam_team', on: 'id' },
  ] },
  { re: /^\/api\/support\/\d+$/, targets: [{ table: 'support_tickets', on: 'id' }] },
  { re: /^\/api\/ar-ap-tracker\/\d+$/, targets: [{ table: 'arap_entries', on: 'id' }] },
  { re: /^\/api\/labour-rate-master\/\d+$/, targets: [{ table: 'labour_rate_master', on: 'id' }] },
  { re: /^\/api\/client-snag\/\d+$/, targets: [{ table: 'client_snags', on: 'id' }] },
  { re: /^\/api\/labour-master\/\d+$/, targets: [{ table: 'labour_master', on: 'id' }] },
  { re: /^\/api\/pms-tasks\/\d+$/, targets: [{ table: 'pms_tasks', on: 'id' }] },
  { re: /^\/api\/solar-site\/studies\/\d+$/, targets: [{ table: 'solar_site_studies', on: 'id' }] },
  { re: /^\/api\/cheques\/\d+$/, targets: [{ table: 'cheques', on: 'id' }] },
  { re: /^\/api\/company-assets\/\d+$/, targets: [{ table: 'company_assets', on: 'id' }] },
  { re: /^\/api\/labour-payment\/\d+$/, targets: [{ table: 'labour_payment_indents', on: 'id' }] },
  { re: /^\/api\/tools\/\d+$/, targets: [
    { table: 'tool_movements', on: 'tool_id' },
    { table: 'tools', on: 'id' },
  ] },
  { re: /^\/api\/installation\/\d+$/, targets: [{ table: 'installations', on: 'id' }] },
  { re: /^\/api\/installation\/ra-bills\/\d+$/, targets: [{ table: 'ra_bills', on: 'id' }] },
  { re: /^\/api\/installation\/mb-bills\/\d+$/, targets: [{ table: 'mb_bills', on: 'id' }] },
  { re: /^\/api\/installation\/inst-bills\/\d+$/, targets: [{ table: 'installation_bills', on: 'id' }] },
  { re: /^\/api\/installation\/testing\/\d+$/, targets: [{ table: 'testing_commissioning', on: 'id' }] },
  { re: /^\/api\/installation\/handover\/\d+$/, targets: [{ table: 'handover_certificates', on: 'id' }] },
  { re: /^\/api\/crm-funnel\/\d+$/, targets: [{ table: 'crm_funnel', on: 'id' }] },
  { re: /^\/api\/customers\/\d+$/, targets: [{ table: 'customers', on: 'id' }] },
  { re: /^\/api\/sub-contractors\/\d+$/, targets: [{ table: 'sub_contractors', on: 'id' }] },
  { re: /^\/api\/module-videos\/\d+$/, targets: [{ table: 'module_help_videos', on: 'id' }] },
  { re: /^\/api\/announcements\/\d+$/, targets: [{ table: 'announcements', on: 'id' }] },
  { re: /^\/api\/leads\/\d+$/, targets: [{ table: 'leads', on: 'id' }] },

  // ── confirmed SOFT DELETES — no row is ever removed, so targets is
  // intentionally empty. Matched explicitly so these are reported as
  // "confirmed nothing lost" rather than lumped in with genuinely unmapped
  // routes that need investigation. ──
  { re: /^\/api\/crm-kitting\/checkpoints\/\d+$/, targets: [] },
  { re: /^\/api\/system-requirements\/\d+$/, targets: [] },
  { re: /^\/api\/system-requirements\/\d+\/comments\/\d+$/, targets: [] },
  { re: /^\/api\/system-requirements\/\d+\/attachments\/\d+$/, targets: [] },
  { re: /^\/api\/site-chat\/\d+$/, targets: [] },
  { re: /^\/api\/site-chat\/\d+\/messages\/\d+$/, targets: [] },
];

function resolveRule(reqPath) {
  for (const rule of TABLE_RULES) if (rule.re.test(reqPath)) return rule;
  return null;
}

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const flag = (n) => argv.includes(`--${n}`);

if (flag('help') || !arg('backup')) {
  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#!.*\n/, ''));
  process.exit(arg('backup') ? 0 : 1);
}

const BACKUP = arg('backup');
const LIVE = arg('live', path.join(__dirname, '..', '..', 'data', 'erp.db'));
const ONLY = arg('table') ? arg('table').split(',').map(s => s.trim()).filter(Boolean) : null;
const IDS = arg('ids') ? arg('ids').split(',').map(s => s.trim()).filter(Boolean) : null;
const SHOW = flag('show');
const APPLY = flag('apply');
const MIN = parseInt(arg('min', '1'), 10);
const DELETED_SINCE = arg('deleted-since');
const DELETED_UNTIL = arg('deleted-until');
const SCOPED = !!(DELETED_SINCE || DELETED_UNTIL);

if (SCOPED && (!DELETED_SINCE || !DELETED_UNTIL)) {
  console.error('Pass BOTH --deleted-since and --deleted-until for audit-scoped mode.');
  process.exit(1);
}
if (SCOPED && (ONLY || IDS)) {
  console.error('--table/--ids are plain-diff-mode options; audit-scoped mode selects rows from the audit log itself.');
  process.exit(1);
}

for (const [label, p] of [['backup', BACKUP], ['live', LIVE]]) {
  if (!fs.existsSync(p)) { console.error(`${label} database not found: ${p}`); process.exit(1); }
}
if (IDS && (!ONLY || ONLY.length !== 1)) {
  console.error('--ids needs exactly one --table'); process.exit(1);
}

// Both opened read-WRITE, with `query_only` locking the live one during a dry
// run. This is not laziness about readonly:true — a readonly connection cannot
// rebuild a stale WAL index, so SQLite quietly serves an OLD snapshot. Diffing
// against a stale snapshot reports rows as "missing" that are really present,
// and worse, hides deletions that happened in the last few minutes. query_only
// gives us read-only behaviour without that trap: writes error at the engine.
const bk = new Database(BACKUP, { fileMustExist: true });
bk.pragma('query_only = ON');            // never write to the evidence
const live = new Database(LIVE, { fileMustExist: true });
if (!APPLY) live.pragma('query_only = ON');

const listTables = (d) => d.prepare(
  `SELECT name FROM sqlite_master WHERE type='table'
     AND name NOT LIKE 'sqlite_%' ORDER BY name`
).all().map(r => r.name);

const liveTables = new Set(listTables(live));
const cols = (d, t) => d.prepare(`PRAGMA table_info("${t}")`).all();

// The key we compare rows on. INTEGER PRIMARY KEY covers almost every table
// here; a composite key is handled too. Tables with no declared key at all
// can't be diffed reliably, so we report them rather than guessing.
function keyCols(d, t) {
  const c = cols(d, t).filter(x => x.pk > 0).sort((a, b) => a.pk - b.pk);
  return c.map(x => x.name);
}

function ist_local(utc) {
  if (!utc) return '—';
  const t = Date.parse(String(utc).replace(' ', 'T') + 'Z');
  if (Number.isNaN(t)) return String(utc);
  return new Date(t + 5.5 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' IST';
}

// Diff ONE step of a chain: which backup rows in `table` WHERE `on` IN
// `values` are missing from live (matched by the table's OWN primary key —
// NOT by `on`, since `on` is often a foreign key shared by many rows, not a
// unique identifier). Also returns the backup rows' own primary-key values,
// so a later chain step can use them as its `from` set.
function diffByColumn(table, onColumn, values) {
  if (!values.length) return { rows: [], missing: [], ownIds: [] };
  if (!liveTables.has(table)) return { skip: 'table does not exist in the live DB' };
  const pk = keyCols(bk, table);
  if (pk.length !== 1) return { skip: pk.length ? 'composite primary key — needs manual handling' : 'no primary key — cannot match rows reliably' };
  const bkColNames = cols(bk, table).map(c => c.name);
  const liveColNames = new Set(cols(live, table).map(c => c.name));
  const shared = bkColNames.filter(c => liveColNames.has(c));
  if (!bkColNames.includes(onColumn)) return { skip: `column "${onColumn}" not found in the backup's copy of this table` };
  if (!liveColNames.has(pk[0])) return { skip: 'primary key differs between the two schemas' };
  const ph = values.map(() => '?').join(',');
  let bkRows;
  try {
    bkRows = bk.prepare(
      `SELECT ${shared.map(c => `"${c}"`).join(',')} FROM "${table}" WHERE "${onColumn}" IN (${ph})`
    ).all(...values);
  } catch (e) { return { skip: `could not read from backup: ${e.message}` }; }
  const liveOwnIds = new Set(
    live.prepare(`SELECT "${pk[0]}" v FROM "${table}" WHERE "${onColumn}" IN (${ph})`)
        .all(...values).map(r => String(r.v))
  );
  const missing = bkRows.filter(r => !liveOwnIds.has(String(r[pk[0]])));
  return { pk: pk[0], shared, rows: bkRows, missing, ownIds: bkRows.map(r => r[pk[0]]) };
}

function restoreFinding(f) {
  const colList = f.shared.map(c => `"${c}"`).join(',');
  const stmt = live.prepare(
    `INSERT OR IGNORE INTO "${f.table}" (${colList}) VALUES (${f.shared.map(() => '?').join(',')})`
  );
  let inserted = 0; const failures = [];
  for (const r of f.missing) {
    try { inserted += stmt.run(...f.shared.map(c => r[c])).changes; }
    catch (e) { failures.push(`${f.pk}=${r[f.pk]}: ${e.message}`); }
  }
  return { inserted, failures };
}

// ── audit-scoped mode ────────────────────────────────────────────────────
if (SCOPED) {
  console.log('='.repeat(78));
  console.log('AUDIT-SCOPED RECOVERY — only rows the audit log confirms were deleted');
  console.log('='.repeat(78));
  console.log(`backup : ${BACKUP}`);
  console.log(`live   : ${LIVE}`);
  console.log(`window : ${DELETED_SINCE}  ->  ${DELETED_UNTIL}  (server-local time, matches audit_log.at)`);
  console.log(`mode   : ${APPLY ? '*** APPLY -- the live database WILL be written ***' : 'dry run (nothing is changed)'}`);
  console.log('');

  let dels;
  try {
    dels = live.prepare(
      `SELECT * FROM audit_log
        WHERE action IN ('DELETE','FORCE_DELETE') AND at BETWEEN ? AND ?
          AND (status_code IS NULL OR (status_code >= 200 AND status_code < 300))
        ORDER BY at`
    ).all(DELETED_SINCE, DELETED_UNTIL);
  } catch (e) {
    console.error(`Could not read audit_log from the live database: ${e.message}`);
    process.exit(1);
  }
  console.log(`${dels.length} successful delete request(s) recorded in this window.`);
  if (!dels.length) {
    console.log('Nothing to restore -- the audit log shows no deletions in this window.');
    process.exit(0);
  }

  // Group by which RULE matched (not by table) -- a rule can define a whole
  // cascade chain, and several delete events for the SAME rule share their
  // root-hop query, so batching per rule (not per event) keeps this fast even
  // at hundreds of deletions.
  const byRule = new Map();          // rule -> Set(entity_id)
  const unmapped = new Map();        // "METHOD path" -> count
  const confirmedSoftDelete = new Map(); // "METHOD path" -> count (targets: [])
  const noNumericId = [];

  for (const d of dels) {
    const rule = resolveRule(d.path || '');
    if (!rule) {
      const key = `${d.method} ${d.path}`;
      unmapped.set(key, (unmapped.get(key) || 0) + 1);
      continue;
    }
    if (rule.targets.length === 0) {
      const key = `${d.method} ${d.path}`;
      confirmedSoftDelete.set(key, (confirmedSoftDelete.get(key) || 0) + 1);
      continue;
    }
    if (!/^\d+$/.test(String(d.entity_id))) { noNumericId.push(d); continue; }
    if (!byRule.has(rule)) byRule.set(rule, new Set());
    byRule.get(rule).add(d.entity_id);
  }

  if (unmapped.size) {
    console.log('');
    console.log('?? Not auto-restorable -- path not in the verified table map (see TABLE_RULES');
    console.log('   at the top of this script). NOT skipped silently: extend the map with the');
    console.log('   real DELETE FROM target (and its WHERE-clause column) from the route');
    console.log('   handler, then re-run.');
    for (const [k, n] of [...unmapped.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`     ${String(n).padStart(4)}x  ${k}`);
    }
  }
  if (confirmedSoftDelete.size) {
    console.log('');
    console.log('OK Confirmed soft deletes -- the row was never actually removed, nothing to restore:');
    for (const [k, n] of [...confirmedSoftDelete.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`     ${String(n).padStart(4)}x  ${k}`);
    }
  }
  if (noNumericId.length) {
    console.log('');
    console.log(`?? ${noNumericId.length} delete(s) matched a table but had no numeric id in the`);
    console.log('   path (e.g. a compound/non-standard route) -- needs manual lookup:');
    for (const d of noNumericId.slice(0, 20)) console.log(`     ${ist_local(d.at)}  ${d.method} ${d.path}`);
  }

  console.log('');
  const findings = [];          // [{table, pk, shared, missing}] deduped by table+pk across rules
  const findingIndex = new Map(); // table -> index into findings
  const skipped = [];
  const chainLines = [];

  for (const [rule, seedSet] of byRule) {
    const seeds = [...seedSet];
    const named = { root: seeds };
    for (const t of rule.targets) {
      const fromVals = named[t.from || 'root'] || [];
      if (!fromVals.length) continue;
      const r = diffByColumn(t.table, t.on, fromVals);
      if (r.skip) { skipped.push([t.table, r.skip]); continue; }
      if (t.as) named[t.as] = r.ownIds;
      chainLines.push({ table: t.table, on: t.on, seedCount: fromVals.length, backupRows: r.rows.length, missing: r.missing.length });
      if (!r.missing.length) continue;
      let idx = findingIndex.get(t.table);
      if (idx === undefined) {
        idx = findings.length;
        findingIndex.set(t.table, idx);
        findings.push({ table: t.table, pk: r.pk, shared: r.shared, missing: [], seenKeys: new Set() });
      }
      for (const row of r.missing) {
        const key = String(row[r.pk]);
        if (!findings[idx].seenKeys.has(key)) { findings[idx].seenKeys.add(key); findings[idx].missing.push(row); }
      }
    }
  }

  // Aggregate the chain detail into one line per table (a table can be hit by
  // more than one rule or more than one hop within a rule).
  const byTableTotals = new Map();
  for (const c of chainLines) {
    const cur = byTableTotals.get(c.table) || { seeds: 0, backupRows: 0, missing: 0 };
    cur.seeds += c.seedCount; cur.backupRows += c.backupRows; cur.missing += c.missing;
    byTableTotals.set(c.table, cur);
  }
  for (const [table, t] of [...byTableTotals.entries()].sort((a, b) => b[1].missing - a[1].missing)) {
    console.log(`  ${table.padEnd(28)} in backup: ${String(t.backupRows).padStart(5)}   restorable now: ${String(t.missing).padStart(5)}`);
  }
  if (skipped.length) {
    console.log('');
    console.log('Not compared:');
    const uniqSkipped = [...new Map(skipped.map(s => [s[0] + '|' + s[1], s])).values()];
    for (const [t, why] of uniqSkipped) console.log(`  ${t.padEnd(28)} ${why}`);
  }

  const totalRestorable = findings.reduce((n, f) => n + f.missing.length, 0);
  console.log('');
  console.log(`${totalRestorable} row(s) across ${findings.length} table(s) will be restored.`);

  if (SHOW) {
    for (const f of findings) {
      console.log('');
      console.log(`-- ${f.table} -- the rows to restore ${'-'.repeat(Math.max(0, 46 - f.table.length))}`);
      for (const r of f.missing.slice(0, 200)) {
        const brief = {};
        for (const [k, v] of Object.entries(r)) {
          if (v === null || v === '') continue;
          brief[k] = typeof v === 'string' && v.length > 60 ? v.slice(0, 59) + '…' : v;
        }
        console.log('  ' + JSON.stringify(brief));
      }
      if (f.missing.length > 200) console.log(`  ... and ${f.missing.length - 200} more`);
    }
  }

  if (!APPLY) {
    console.log('');
    console.log('Dry run -- nothing was written. Pass --show to see the actual rows, --apply to restore.');
    process.exit(0);
  }
  if (!totalRestorable) { console.log('\nNothing to restore.'); process.exit(0); }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safety = `${LIVE}.before-restore-${stamp}`;
  fs.copyFileSync(LIVE, safety);
  console.log('');
  console.log(`Safety copy of the live database: ${safety}`);

  const fkWasOn = live.pragma('foreign_keys', { simple: true });
  live.pragma('foreign_keys = OFF');
  let grandInserted = 0;
  const run = live.transaction(() => {
    for (const f of findings) {
      const { inserted, failures } = restoreFinding(f);
      grandInserted += inserted;
      console.log(`  ${f.table.padEnd(28)} restored ${inserted}${failures.length ? `, ${failures.length} FAILED` : ''}`);
      for (const m of failures.slice(0, 5)) console.log(`      failed: ${m}`);
    }
  });
  run();
  live.pragma(`foreign_keys = ${fkWasOn ? 'ON' : 'OFF'}`);

  console.log('');
  console.log(`Restored ${grandInserted} row(s) total.`);
  const dangling = live.pragma('foreign_key_check');
  if (dangling.length) {
    console.log('');
    console.log(`${dangling.length} row(s) now point at a parent that no longer exists -- that parent`);
    console.log('table likely also needs restoring (its own deletion may be outside this window,');
    console.log('or its route is in the "not auto-restorable" list above):');
    const byT = {};
    for (const d of dangling) byT[d.table] = (byT[d.table] || 0) + 1;
    for (const [t, n] of Object.entries(byT)) console.log(`  ${t.padEnd(34)} ${n}`);
  } else {
    console.log('No dangling references -- the database is internally consistent.');
  }
  console.log(`integrity_check: ${live.pragma('integrity_check', { simple: true })}`);
  console.log('');
  console.log('Restart the app so nothing is serving a stale cache:  pm2 restart erp');

  bk.close(); live.close();
  process.exit(0);
}

// ── plain-diff mode ──────────────────────────────────────────────────────
console.log('='.repeat(78));
console.log('ROWS PRESENT IN THE BACKUP BUT MISSING FROM THE LIVE DATABASE');
console.log('='.repeat(78));
console.log(`backup : ${BACKUP}`);
console.log(`live   : ${LIVE}`);
console.log(`mode   : ${APPLY ? '*** APPLY -- the live database WILL be written ***' : 'dry run (nothing is changed)'}`);
console.log('');

const findings = [];
const skipped = [];

for (const t of listTables(bk)) {
  if (ONLY && !ONLY.includes(t)) continue;
  if (t === 'sqlite_sequence' || t === 'app_migrations') continue;
  if (!liveTables.has(t)) { skipped.push([t, 'table does not exist in the live DB']); continue; }

  const pk = keyCols(bk, t);
  if (!pk.length) { skipped.push([t, 'no primary key — cannot match rows reliably']); continue; }

  // Only columns the two schemas share, so a migration that added or dropped a
  // column since the backup doesn't break the insert.
  const bkCols = cols(bk, t).map(c => c.name);
  const liveCols = new Set(cols(live, t).map(c => c.name));
  const shared = bkCols.filter(c => liveCols.has(c));
  if (!pk.every(k => liveCols.has(k))) { skipped.push([t, 'primary key differs between the two schemas']); continue; }

  let bkRows;
  try {
    const sel = `SELECT ${shared.map(c => `"${c}"`).join(',')} FROM "${t}"`;
    bkRows = IDS
      ? bk.prepare(`${sel} WHERE "${pk[0]}" IN (${IDS.map(() => '?').join(',')})`).all(...IDS)
      : bk.prepare(sel).all();
  } catch (e) { skipped.push([t, `could not read from backup: ${e.message}`]); continue; }
  if (!bkRows.length) continue;

  // Pull just the keys from live and diff in memory — one query per table
  // instead of one per row, which matters on tables with tens of thousands.
  const liveKeys = new Set(
    live.prepare(`SELECT ${pk.map(c => `"${c}"`).join(',')} FROM "${t}"`).all()
        .map(r => pk.map(c => String(r[c])).join(' '))
  );
  const missing = bkRows.filter(r => !liveKeys.has(pk.map(c => String(r[c])).join(' ')));
  if (missing.length >= MIN) findings.push({ table: t, pk, shared, missing });
}

if (!findings.length) {
  console.log('Nothing is missing. Every row in the backup is still present live.');
} else {
  const w = Math.max(...findings.map(f => f.table.length), 24);
  for (const f of findings.sort((a, b) => b.missing.length - a.missing.length)) {
    console.log(`  ${f.table.padEnd(w)}  ${String(f.missing.length).padStart(7)} row(s) missing   (key: ${f.pk.join('+')})`);
  }
  console.log('');
  console.log(`  ${findings.reduce((n, f) => n + f.missing.length, 0)} row(s) missing across ${findings.length} table(s).`);
}

if (skipped.length) {
  console.log('');
  console.log('Not compared:');
  for (const [t, why] of skipped) console.log(`  ${t.padEnd(34)} ${why}`);
}

if (SHOW) {
  for (const f of findings) {
    console.log('');
    console.log(`── ${f.table} — the missing rows ${'─'.repeat(Math.max(0, 50 - f.table.length))}`);
    for (const r of f.missing.slice(0, 200)) {
      const brief = {};
      for (const [k, v] of Object.entries(r)) {
        if (v === null || v === '') continue;
        brief[k] = typeof v === 'string' && v.length > 60 ? v.slice(0, 59) + '…' : v;
      }
      console.log('  ' + JSON.stringify(brief));
    }
    if (f.missing.length > 200) console.log(`  … and ${f.missing.length - 200} more`);
  }
}

if (!APPLY) {
  console.log('');
  console.log('Dry run — nothing was written.');
  if (findings.length) {
    console.log('Inspect one table first:');
    console.log(`   node server/scripts/incident-restore.js --backup "${BACKUP}" --table ${findings[0].table} --show`);
    console.log('Then restore that table:');
    console.log(`   node server/scripts/incident-restore.js --backup "${BACKUP}" --table ${findings[0].table} --apply`);
    console.log('');
    console.log('Restore deliberately, one table at a time. A missing row may simply have');
    console.log('been deleted on purpose after this backup was taken — check it against the');
    console.log('forensics report before putting it back.');
  }
  process.exit(0);
}

// ── apply ──────────────────────────────────────────────────────────────────
if (!findings.length) { console.log('\nNothing to restore.'); process.exit(0); }
if (!ONLY) {
  console.error('\nRefusing to restore every table at once. Pass --table <name> and work');
  console.error('through them one at a time so each restore is a decision you made.');
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const safety = `${LIVE}.before-restore-${stamp}`;
fs.copyFileSync(LIVE, safety);
console.log('');
console.log(`Safety copy of the live database: ${safety}`);
console.log('(if anything about this restore looks wrong, stop the app and copy that back)');

let insertedTotal = 0, failedTotal = 0;
const failuresTotal = [];
// Foreign keys off for the duration: a deleted parent and its children come
// back in whatever order the tables are processed, and an FK error mid-way
// would abort a restore that is actually fine once both halves are present.
// We run a full foreign_key_check afterwards and report anything left dangling.
const fkWasOn = live.pragma('foreign_keys', { simple: true });
live.pragma('foreign_keys = OFF');

const run = live.transaction((f) => {
  const { inserted, failures } = restoreFinding(f);
  insertedTotal += inserted;
  failedTotal += failures.length;
  for (const m of failures.slice(0, 10)) failuresTotal.push(m);
});

for (const f of findings) {
  console.log(`\nRestoring ${f.missing.length} row(s) into ${f.table} …`);
  run(f);
}

live.pragma(`foreign_keys = ${fkWasOn ? 'ON' : 'OFF'}`);

console.log('');
console.log(`Restored ${insertedTotal} row(s). ${failedTotal ? `${failedTotal} failed.` : ''}`);
for (const m of failuresTotal) console.log(`  failed: ${m}`);

const dangling = live.pragma('foreign_key_check');
if (dangling.length) {
  console.log('');
  console.log(`${dangling.length} row(s) now point at a parent that no longer exists:`);
  const byTable = {};
  for (const d of dangling) byTable[d.table] = (byTable[d.table] || 0) + 1;
  for (const [t, n] of Object.entries(byTable)) console.log(`  ${t.padEnd(34)} ${n}`);
  console.log('Usually this means the PARENT table still needs restoring too — run the');
  console.log('dry run again and restore that table next.');
} else {
  console.log('No dangling references — the database is internally consistent.');
}

const integrity = live.pragma('integrity_check', { simple: true });
console.log(`integrity_check: ${integrity}`);
console.log('');
console.log('Restart the app so nothing is serving a stale cache:  pm2 restart erp');

bk.close();
live.close();
