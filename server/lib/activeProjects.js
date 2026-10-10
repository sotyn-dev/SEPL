// Company-wide operational project count. Keep all inclusion and identity rules
// here; consumers must not independently count orders, companies or site rows.
const DEFINITION = 'A project with at least one site marked Active. Completed and on-hold sites do not qualify it. Duplicate sites and orders count once.';
const normalize = col => `UPPER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(${col}, ''), CHAR(160), ''), CHAR(9), ''), CHAR(10), ''), CHAR(13), ''), ' ', ''), '"', ''), CHAR(39), ''))`;

// Business Book can contain several orders for the same named project. Include
// company in its identity so identically named projects for different clients
// remain separate. Unlinked legacy sites join a known project only when their
// normalized site name has exactly one linked identity; never guess ambiguities.
const ACTIVE_PROJECTS_CTE = `WITH
  books AS (
    SELECT id,
      COALESCE(NULLIF(TRIM(project_name), ''), NULLIF(TRIM(company_name), '')) AS name,
      CASE WHEN ${normalize("COALESCE(NULLIF(TRIM(project_name), ''), company_name)")} <> ''
        THEN 'project:' || json_array(${normalize('company_name')}, ${normalize("COALESCE(NULLIF(TRIM(project_name), ''), company_name)")})
        ELSE 'book:' || id END AS project_key
    FROM business_book
  ),
  linked_sites AS (
    SELECT s.id AS site_id, s.name AS site_name, s.status,
      ${normalize('s.name')} AS name_key,
      COALESCE(direct.project_key, via_po.project_key) AS linked_key,
      COALESCE(direct.name, via_po.name, NULLIF(TRIM(s.name), ''), 'Unnamed site #' || s.id) AS project_name
    FROM sites s
    LEFT JOIN purchase_orders po ON po.id = s.po_id
    LEFT JOIN books direct ON direct.id = NULLIF(s.business_book_id, 0)
    LEFT JOIN books via_po ON via_po.id = NULLIF(po.business_book_id, 0)
  ),
  name_links AS (
    SELECT name_key, MIN(linked_key) AS project_key
    FROM linked_sites WHERE linked_key IS NOT NULL AND name_key <> ''
    GROUP BY name_key HAVING COUNT(DISTINCT linked_key) = 1
  ),
  project_sites AS (
    SELECT ls.*,
      COALESCE(ls.linked_key, nl.project_key,
        CASE WHEN ls.name_key <> '' THEN 'site:' || ls.name_key ELSE 'site-id:' || ls.site_id END) AS project_key
    FROM linked_sites ls LEFT JOIN name_links nl ON nl.name_key = ls.name_key
  ),
  active_projects AS (
    SELECT project_key, MIN(project_name) AS name, MIN(site_id) AS representative_site_id,
      COUNT(*) AS active_site_rows,
      SUM(CASE WHEN linked_key IS NULL THEN 1 ELSE 0 END) AS unlinked_site_rows
    FROM project_sites WHERE status = 'active'
    GROUP BY project_key
  )`;

function getActiveProjectMetric(db) {
  // Do not swallow database errors as zero: an unavailable metric is not an
  // empty project portfolio. No cache, historical cutoff or page filter.
  const row = db.prepare(`${ACTIVE_PROJECTS_CTE}
    SELECT COUNT(*) AS count, COALESCE(SUM(active_site_rows), 0) AS active_site_rows,
      COALESCE(SUM(unlinked_site_rows), 0) AS unlinked_site_rows
    FROM active_projects`).get();
  return { ...row, key: 'active_projects', label: 'Active Projects', scope: 'company',
    definition: DEFINITION, definition_version: 1, as_of: new Date().toISOString() };
}

function listActiveProjects(db) {
  return db.prepare(`${ACTIVE_PROJECTS_CTE}
    SELECT * FROM active_projects ORDER BY name, project_key`).all();
}

// Numerators must use the same project membership as the denominator. A DPR on
// a duplicate site counts once; a plan-only DPR or an inactive project cannot
// inflate project-level adherence. Employee scorecards use their own rules.
function countActiveProjectsWithDpr(db, date) {
  return db.prepare(`${ACTIVE_PROJECTS_CTE}
    SELECT COUNT(DISTINCT ap.project_key) AS count
    FROM active_projects ap JOIN project_sites ps ON ps.project_key = ap.project_key
    JOIN dpr d ON d.site_id = ps.site_id
    WHERE d.report_date = ? AND COALESCE(d.is_planned_template, 0) = 0
      AND d.submission_time IS NOT NULL`).get(date).count;
}

module.exports = { ACTIVE_PROJECTS_CTE, getActiveProjectMetric, listActiveProjects, countActiveProjectsWithDpr };
