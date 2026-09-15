// SPOS daily-compliance compute (mam 2026-07-29) — per active site,
// rolled up ENGINEER-WISE for display (mam 2026-08-21: "here site missing
// showing but no need compliance eng wise that ok") — sites with no
// engineer no longer get a row, only a counted advisory.
// Answers the four SPOS HR-checklist questions for a given date:
//   1. Morning manpower punched? (target: by 09:00 IST)
//   2. DPR submitted? (target: by 20:00 IST evening cutoff)
//   3. Site photos uploaded on the DPR?
//   4. Weekly plan approved for the week containing that date?
// Shared by GET /dpr/spos-compliance (dashboard grid) and the 18:30
// exception-report cron, so both always agree.
//
// DB timestamps (CURRENT_TIMESTAMP) are UTC 'YYYY-MM-DD HH:MM:SS'; all
// targets are IST wall-clock, converted here (IST = UTC+5:30).

const IST_OFFSET_MIN = 330;

// UTC instant for `dateIso hh:mm` IST wall-clock.
function istInstant(dateIso, hh, mm) {
  return new Date(new Date(dateIso + 'T00:00:00Z').getTime() + ((hh * 60 + mm) - IST_OFFSET_MIN) * 60000);
}

// Parse a SQLite UTC timestamp ('YYYY-MM-DD HH:MM:SS') to a Date.
function parseUtc(ts) {
  if (!ts) return null;
  return new Date(String(ts).replace(' ', 'T') + (String(ts).endsWith('Z') ? '' : 'Z'));
}

// Monday of the week containing dateIso (weekly plans are keyed on Mondays).
function mondayOf(dateIso) {
  const d = new Date(dateIso + 'T00:00:00Z');
  const dow = (d.getUTCDay() + 6) % 7;   // Mon=0 … Sun=6
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

function computeSposCompliance(db, dateIso) {
  const weekStart = mondayOf(dateIso);
  const nineAm = istInstant(dateIso, 9, 0);
  const dprCutoff = istInstant(dateIso, 20, 0);

  // Group phantom duplicate sites rows (Excel paste artifacts — the DPR
  // module collapses them the same way in GET /dpr/sites). Every check
  // then looks across ALL the duplicate ids, so a punch/DPR keyed to any
  // one of them counts (audit 2026-07-31: duplicates reported permanent
  // false "missing" gaps to management).
  const siteKey = (name) => String(name || '').replace(/[\s" ']/g, '').toUpperCase();
  // Engineer attribution (mam 2026-08-21, engineer-wise rows): sites
  // .site_engineer_id is NULL on most prod sites — the engineer is pinned
  // on the linked PO (see dpr.js:2208). Same narrow chain as
  // /dpr/engineer-compliance so the two stacked panels agree.
  const raw = db.prepare(`
    SELECT s.id, s.name, s.po_id, s.business_book_id,
           s.site_engineer_id,
           (SELECT po.site_engineer_id FROM purchase_orders po
             WHERE (po.id = s.po_id OR po.business_book_id = s.business_book_id)
               AND po.site_engineer_id IS NOT NULL LIMIT 1) AS po_eng_id,
           (SELECT po.site_engineer_ids FROM purchase_orders po
             WHERE (po.id = s.po_id OR po.business_book_id = s.business_book_id)
               AND COALESCE(po.site_engineer_ids,'') <> '' LIMIT 1) AS po_eng_csv
      FROM sites s
     WHERE s.status = 'active'
     ORDER BY s.name
  `).all();
  // Eligible engineer pool — byte-for-byte the same pool as
  // /dpr/engineer-compliance (dpr.js:2187): ACTIVE users holding a role whose
  // name contains "site eng". Audit 2026-08-21: resolving any users row let a
  // plain Admin (PO 1 → user 1 locally) and DEACTIVATED ex-employees own a
  // compliance row that can never go green — the same permanent wall of red
  // this change removed, just relabelled — and made this grid disagree with
  // the Engineer Performance panel stacked right beneath it.
  const eligible = new Map(db.prepare(`
    SELECT u.id, u.name
      FROM users u
      JOIN user_roles ur ON ur.user_id = u.id
      JOIN roles r       ON r.id = ur.role_id
     WHERE u.active = 1
     GROUP BY u.id
     HAVING SUM(CASE WHEN LOWER(r.name) LIKE '%site eng%' THEN 1 ELSE 0 END) > 0
  `).all().map(r => [r.id, r.name]));
  const userName = (id) => (id ? eligible.get(id) || null : null);
  // First match wins; a multi-engineer PO CSV resolves to the LOWEST eligible
  // id so one site never lands under two engineer rows (double-counting would
  // corrupt every denominator). Jr/supervisor links are deliberately NOT
  // used for attribution — they are not the accountable owner. An id that is
  // not an active site engineer stays unassigned, never a nameless row.
  const resolveEngineer = (s) => {
    if (s.site_engineer_id) {
      const n = userName(s.site_engineer_id);
      if (n) return { id: s.site_engineer_id, name: n };
    }
    if (s.po_eng_id) {
      const n = userName(s.po_eng_id);
      if (n) return { id: s.po_eng_id, name: n };
    }
    const ids = String(s.po_eng_csv || '').split(',').map(Number)
      .filter(x => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
    for (const id of ids) {
      const n = userName(id);
      if (n) return { id, name: n };
    }
    return { id: null, name: null };
  };
  const grouped = new Map();
  for (const s of raw) {
    const k = siteKey(s.name);
    const g = grouped.get(k) || { site_id: s.id, site: s.name, engineer_id: null, engineer: null, ids: [] };
    g.ids.push(s.id);
    if (!g.engineer_id) {
      const e = resolveEngineer(s);
      if (e.id) { g.engineer_id = e.id; g.engineer = e.name; }
    }
    grouped.set(k, g);
  }
  const sites = [...grouped.values()];

  const rows = sites.map(s => {
    const ph2 = s.ids.map(() => '?').join(',');
    const punch = db.prepare(`SELECT MIN(created_at) t, COUNT(*) c FROM contractor_attendance WHERE site_id IN (${ph2}) AND attendance_date = ?`).get(...s.ids, dateIso);
    const dpr = db.prepare(`SELECT submission_time, site_photos FROM dpr WHERE site_id IN (${ph2}) AND report_date = ? AND submission_time IS NOT NULL LIMIT 1`).get(...s.ids, dateIso);
    const plan = db.prepare(`SELECT status, submitted_late FROM weekly_plans WHERE site_id IN (${ph2}) AND week_start = ? ORDER BY CASE status WHEN 'approved' THEN 0 WHEN 'submitted' THEN 1 ELSE 2 END LIMIT 1`).get(...s.ids, weekStart);
    // Photos: dpr.site_photos has no writer yet — the REAL photo evidence
    // in the system today is the morning-punch photo (contractor_attendance
    // .photo_url), so count that too (audit 2026-07-31: the old check was
    // permanently false → daily false alarms to the director).
    const punchPhoto = db.prepare(`SELECT 1 ok FROM contractor_attendance WHERE site_id IN (${ph2}) AND attendance_date = ? AND COALESCE(photo_url,'') <> '' LIMIT 1`).get(...s.ids, dateIso);
    const punchAt = parseUtc(punch.t);
    const dprAt = dpr ? parseUtc(dpr.submission_time) : null;
    const dprPhotos = dpr ? String(dpr.site_photos || '').trim() : '';
    return {
      site_id: s.site_id,
      site_ids: s.ids,
      site: s.site,
      engineer: s.engineer || null,
      engineer_id: s.engineer_id || null,
      punch_done: punch.c > 0,
      punch_at: punch.t || null,
      punch_by_9: punch.c > 0 && !!punchAt && punchAt <= nineAm,
      dpr_done: !!dpr,
      dpr_at: dpr ? dpr.submission_time : null,
      dpr_by_cutoff: !!dpr && !!dprAt && dprAt <= dprCutoff,
      photos_done: !!punchPhoto || (!!dprPhotos && dprPhotos !== '[]' && dprPhotos !== 'null'),
      plan_status: plan ? plan.status : 'missing',
      plan_late: plan ? !!plan.submitted_late : false,
    };
  });

  return { date: dateIso, week_start: weekStart, sites: rows, ...rollupByEngineer(rows) };
}

// Engineer-wise rollup (mam 2026-08-21: "here site missing showing but no
// need compliance eng wise that ok"). One row per engineer who owns at
// least one active site; each check is an honest fraction across ALL that
// engineer's sites, so a green tick means every one of them did it. Sites
// with no engineer produce NO row — only the sites_unassigned count.
// Pure function: the route re-runs it on the viewer-filtered rows so an
// aggregate can never span a site the viewer cannot otherwise see.
function rollupByEngineer(rows) {
  const assigned = rows.filter(r => r.engineer_id);
  const byEng = new Map();
  for (const r of assigned) {
    const g = byEng.get(r.engineer_id) || { engineer_id: r.engineer_id, engineer: r.engineer, rows: [] };
    g.rows.push(r);
    byEng.set(r.engineer_id, g);
  }
  const engineers = [...byEng.values()]
    .sort((a, b) => String(a.engineer || '').localeCompare(String(b.engineer || '')))
    .map(g => {
      const rs = [...g.rows].sort((a, b) => String(a.site || '').localeCompare(String(b.site || '')));
      const total = rs.length;
      const names = (f) => rs.filter(f).map(r => r.site);
      const punchDone = rs.filter(r => r.punch_done).length;
      const punchOnTime = rs.filter(r => r.punch_done && r.punch_by_9).length;
      const dprDone = rs.filter(r => r.dpr_done).length;
      const dprOnTime = rs.filter(r => r.dpr_done && r.dpr_by_cutoff).length;
      const photosDone = rs.filter(r => r.photos_done).length;
      const photosMissing = rs.filter(r => !r.photos_done && r.dpr_done).length;
      const planApproved = rs.filter(r => r.plan_status === 'approved').length;
      const planSubmitted = rs.filter(r => r.plan_status === 'submitted').length;
      const planRejected = rs.filter(r => r.plan_status === 'rejected').length;
      return {
        engineer_id: g.engineer_id,
        engineer: g.engineer,
        sites_count: total,
        site_ids: rs.flatMap(r => r.site_ids || [r.site_id]),
        site_names: rs.map(r => r.site),
        punch: {
          total, done: punchDone, on_time: punchOnTime, late: punchDone - punchOnTime,
          missing: total - punchDone,
          at: total === 1 && punchDone === 1 ? rs[0].punch_at : null,
          late_sites: names(r => r.punch_done && !r.punch_by_9),
          missing_sites: names(r => !r.punch_done),
        },
        dpr: {
          total, done: dprDone, on_time: dprOnTime, late: dprDone - dprOnTime,
          missing: total - dprDone,
          at: total === 1 && dprDone === 1 ? rs[0].dpr_at : null,
          late_sites: names(r => r.dpr_done && !r.dpr_by_cutoff),
          missing_sites: names(r => !r.dpr_done),
        },
        // Photos are only "due" once the DPR is in — keep the three-state
        // semantics (done / genuinely missing / not due yet).
        photos: {
          total, done: photosDone, missing: photosMissing,
          pending: total - photosDone - photosMissing,
          missing_sites: names(r => !r.photos_done && r.dpr_done),
        },
        plan: {
          total, approved: planApproved,
          late: rs.filter(r => r.plan_status === 'approved' && r.plan_late).length,
          submitted: planSubmitted, rejected: planRejected,
          missing: total - planApproved - planSubmitted - planRejected,
          missing_sites: names(r => !['approved', 'submitted', 'rejected'].includes(r.plan_status)),
          pending_sites: names(r => r.plan_status === 'submitted'),
          rejected_sites: names(r => r.plan_status === 'rejected'),
        },
      };
    });

  // The four headline percentages stay PER SITE (audit 2026-08-21): mam asked
  // for engineer-wise ROWS, not a new metric. An all-or-nothing per-engineer
  // count would print "Punch 0%" on a day 9 of 10 sites punched, and the same
  // 0% would go to the director in the 18:30 mail. Only the denominator
  // narrows — to the sites that have an engineer, i.e. exactly the sites the
  // grid draws; the rest are declared by summary.sites_unassigned. Lateness
  // still doesn't reduce a pct (unchanged: punch_done counted, punch_by_9
  // ignored).
  // NO engineer-owned site = 0/0, which is UNKNOWN, not 0% (audit 2026-08-21).
  // The old `|| 1` denominator turned that undefined ratio into a confident
  // "Attendance 0%" — and on prod, where no site has a site engineer yet, that
  // is what the director's 18:30 mail would say on a fully compliant day. null
  // means "no denominator": the grid already hides the tiles in that state and
  // sposExceptionReport.js now words the headline instead of printing zeros.
  const n = assigned.length;
  const pct = (f) => n === 0 ? null : Math.round(assigned.filter(f).length / n * 100);
  const summary = {
    engineers: engineers.length,
    sites: rows.length,
    sites_assigned: assigned.length,
    sites_unassigned: rows.length - assigned.length,
    punch_pct: pct(r => r.punch_done),
    dpr_pct: pct(r => r.dpr_done),
    photos_pct: pct(r => r.photos_done),
    plan_approved_pct: pct(r => r.plan_status === 'approved'),
  };
  return { engineers, summary };
}

// Site-store inventory ageing (mam 2026-08-03): "sr. engineer is
// responsible for inventory ageing, 15 days is allowed only, maximum 30
// days — make it live." Age = days since the item's LAST stock-IN into
// that site store (fresh receipt resets the clock).
//   ok ≤ 15d · orange 16-30d · red > 30d
// Single source of truth — used by GET /dpr/site-store-ageing (dashboard
// widget + slip chips) AND the 18:30 exception report.
function computeStoreAgeing(db) {
  const now = Date.now();
  return db.prepare(`
    SELECT s.id site_id, s.name site_name, u.name engineer_name, w.id warehouse_id,
           sb.item_master_id, sb.quantity, sb.avg_rate,
           im.item_name, im.specification, im.size, im.uom,
           (SELECT MAX(sm.created_at) FROM stock_movements sm
             WHERE sm.warehouse_id = w.id AND sm.item_master_id = sb.item_master_id AND sm.type = 'IN') last_in
      FROM stock_balance sb
      JOIN warehouses w ON w.id = sb.warehouse_id AND w.type = 'site_store' AND COALESCE(w.active,1) = 1
      JOIN sites s ON s.id = w.site_id
      LEFT JOIN users u ON u.id = s.site_engineer_id
      JOIN item_master im ON im.id = sb.item_master_id
     WHERE sb.quantity > 0
  `).all().map(r => {
    const lastIn = r.last_in ? new Date(String(r.last_in).replace(' ', 'T') + 'Z') : null;
    const age = lastIn ? Math.floor((now - lastIn.getTime()) / 86400000) : null;
    return {
      ...r,
      material_name: [r.item_name, r.specification, r.size].filter(Boolean).join(' '),
      age_days: age,
      status: age === null ? 'unknown' : age > 30 ? 'red' : age > 15 ? 'orange' : 'ok',
    };
  }).sort((a, b) => (b.age_days || 0) - (a.age_days || 0));
}

module.exports = { computeSposCompliance, rollupByEngineer, mondayOf, computeStoreAgeing };
