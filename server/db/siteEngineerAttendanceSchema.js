// Schema migration and helpers for Site Engineer DPR-linked Overtime and Sunday Attendance
// Addresses tickets:
//   - TK-01466: Mandatory DPR for overtime punch-out (>10h), else clamp to shift end
//   - TK-01401: Transparent explanations on rejection so salary day creates no disputes
//   - TSK-1020: Strict control on Sunday double attendance misuse via DPR profitability

function addColumnIfNotExists(db, table, columnDef) {
  const colName = columnDef.trim().split(/\s+/)[0];
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(colName)) {
    try {
      db.prepare(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`).run();
    } catch (e) {
      if (!e.message.includes('duplicate column')) throw e;
    }
  }
}

function runSiteEngineerAttendanceMigrations(db) {
  addColumnIfNotExists(db, 'attendance', 'ot_status TEXT DEFAULT NULL');
  addColumnIfNotExists(db, 'attendance', 'dpr_id INTEGER DEFAULT NULL');
  addColumnIfNotExists(db, 'attendance', 'dpr_profit_loss REAL DEFAULT NULL');
  addColumnIfNotExists(db, 'attendance', 'ot_rejection_reason TEXT DEFAULT NULL');
  addColumnIfNotExists(db, 'attendance', 'pm_approved_at DATETIME DEFAULT NULL');
  addColumnIfNotExists(db, 'attendance', 'pm_approved_by INTEGER DEFAULT NULL');
  addColumnIfNotExists(db, 'sites', 'site_engineer_ids TEXT DEFAULT NULL');
}

/**
 * Checks whether a given user is classified as a Site Engineer / Site Staff.
 * Criteria:
 *   1. Assigned as site_engineer_id or in site_engineer_ids on any active/all site or purchase order
 *   2. User department is 'Site Operations' or role is 'site_engineer'
 *   3. Employee roster is 'early' (9:00 AM - 6:00 PM site staff) AND in Operations/Site
 *   4. Employee designation or department contains 'site'
 * (Office staff in Sales, HR, Accounts, Finance, Management etc. are never site engineers)
 */
function isSiteEngineer(db, userId) {
  if (!userId || !db) return false;
  try {
    // 0. Fetch user and employee records
    const user = db.prepare(`SELECT id, role, department FROM users WHERE id = ?`).get(userId);
    if (!user || user.role === 'admin') return false;

    let emp = null;
    try {
      emp = db.prepare(`SELECT id, designation, department, staff_type, employment_type FROM employees WHERE user_id = ?`).get(userId);
    } catch (_) {}

    const desig = String(emp?.designation || '').toLowerCase().trim();
    const dept = String(emp?.department || user?.department || '').toLowerCase().trim();
    const uRole = String(user.role || '').toLowerCase().trim();

    // 1. Explicit Exclusions: Manpower, Labor, Helpers, Welders, Fitters, Electricians, Store, Audit, Office
    const isManpowerOrNonEngineer = (text) => {
      if (!text) return false;
      return [
        'helper', 'fitter', 'welder', 'electrician', 'technician', 'manpower', 'labor', 'labour',
        'driver', 'plumber', 'carpenter', 'mason', 'store', 'incharge', 'auditor', 'inventory auditor',
        'billing', 'trainee', 'apprentice', 'intern', 'pms', 'crm', 'sales', 'hr', 'accountant',
        'accounts', 'finance', 'drawing viewer', 'viewer', 'legal', 'compliance', 'data entry',
        'coo', 'dmm', 'dme', 'ea to md', 'management', 'director'
      ].some(k => text === k || text.includes(k));
    };

    // If their designation or direct role is manpower / non-engineer, immediately exempt
    if (isManpowerOrNonEngineer(desig)) return false;
    if (isManpowerOrNonEngineer(uRole)) return false;

    // 2. Check assigned roles in roles / user_roles table
    let assignedRoleNames = [];
    try {
      const hasRolesTable = !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='roles'`).get();
      const hasUserRolesTable = !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='user_roles'`).get();
      if (hasRolesTable && hasUserRolesTable) {
        assignedRoleNames = db.prepare(`
          SELECT r.name FROM roles r
          JOIN user_roles ur ON r.id = ur.role_id
          WHERE ur.user_id = ?
        `).all(userId).map(r => String(r.name || '').toLowerCase().trim());
      }
    } catch (_) {}

    // Check if any assigned role is Manpower / Helper / Non-engineer
    if (assignedRoleNames.some(r => isManpowerOrNonEngineer(r))) {
      // If they have Helper or non-engineer role and DO NOT have explicit Site Engineer role, exempt
      const hasEngRole = assignedRoleNames.some(r => 
        r === 'site engineer' || r === 'jr. site eng' || r === 'jr. site engineer' || r === 'junior site engineer' || r === 'sr. site engineer'
      );
      if (!hasEngRole) return false;
    }

    // 3. Strict Match for Site Engineer or Jr. Site Engineer:
    const isSiteEngName = (name) => {
      if (!name) return false;
      const clean = name.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
      return (
        clean === 'site engineer' ||
        clean === 'jr site eng' ||
        clean === 'jr site engineer' ||
        clean === 'junior site engineer' ||
        clean === 'sr site engineer' ||
        clean === 'senior site engineer' ||
        clean.startsWith('site engineer') ||
        clean.startsWith('jr site engineer') ||
        clean.startsWith('junior site engineer')
      );
    };

    // A. Role match
    const hasExplicitSiteEngRole = assignedRoleNames.some(isSiteEngName) || isSiteEngName(uRole);
    if (hasExplicitSiteEngRole) return true;

    // B. Designation match
    if (isSiteEngName(desig)) return true;

    // C. Explicit Site / PO Engineer Assignment
    // Must be assigned in site_engineer_id, site_engineer_ids, or jr_site_engineer_ids
    // AND must NOT have an office/manpower designation
    let siteAssigned = false;
    try {
      const hasPo = !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='purchase_orders'`).get();
      if (hasPo) {
        siteAssigned = !!db.prepare(`
          SELECT 1 FROM sites s
          LEFT JOIN purchase_orders po ON po.id = s.po_id
          WHERE s.site_engineer_id = ?
             OR po.site_engineer_id = ?
             OR (po.site_engineer_ids IS NOT NULL AND (',' || po.site_engineer_ids || ',') LIKE ('%,' || ? || ',%'))
             OR (po.jr_site_engineer_ids IS NOT NULL AND (',' || po.jr_site_engineer_ids || ',') LIKE ('%,' || ? || ',%'))
             OR (s.site_engineer_ids IS NOT NULL AND (',' || s.site_engineer_ids || ',') LIKE ('%,' || ? || ',%'))
          LIMIT 1
        `).get(userId, userId, String(userId), String(userId), String(userId));
      } else {
        siteAssigned = !!db.prepare(`
          SELECT 1 FROM sites 
          WHERE site_engineer_id = ? 
             OR (site_engineer_ids IS NOT NULL AND (',' || site_engineer_ids || ',') LIKE ('%,' || ? || ',%'))
          LIMIT 1
        `).get(userId, String(userId));
      }
    } catch (_) {
      try {
        siteAssigned = !!db.prepare(`SELECT 1 FROM sites WHERE site_engineer_id = ? LIMIT 1`).get(userId);
      } catch (_) {}
    }

    if (siteAssigned) {
      // Check DPR permission - must have DPR access
      try {
        const hasRolePerms = !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='role_permissions'`).get();
        if (hasRolePerms && assignedRoleNames.length > 0) {
          const permRow = db.prepare(`
            SELECT 1 FROM role_permissions rp
            JOIN user_roles ur ON rp.role_id = ur.role_id
            WHERE ur.user_id = ? AND rp.module = 'dpr' AND (rp.can_create = 1 OR rp.can_edit = 1)
            LIMIT 1
          `).get(userId);
          if (permRow) return true;
        } else {
          // If no role_permissions table or standalone user assigned to site
          if (!isManpowerOrNonEngineer(desig) && !isManpowerOrNonEngineer(uRole) && !isManpowerOrNonEngineer(dept)) {
            return true;
          }
        }
      } catch (_) {
        if (!isManpowerOrNonEngineer(desig) && !isManpowerOrNonEngineer(uRole) && !isManpowerOrNonEngineer(dept)) {
          return true;
        }
      }
    }

    return false;
  } catch (_) {
    return false;
  }
}

/**
 * Finds the submitted DPR for a site engineer on a given date.
 */
function findSiteEngineerDpr(db, userId, dateStr) {
  try {
    let attendanceSiteIds = [];
    try {
      const attCols = db.prepare(`PRAGMA table_info(attendance)`).all().map(c => c.name);
      if (attCols.includes('site_id') || attCols.includes('site_name')) {
        const hasSites = !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='sites'`).get();
        if (hasSites && attCols.includes('site_name') && attCols.includes('site_id')) {
          const rows = db.prepare(`
            SELECT DISTINCT COALESCE(a.site_id, s2.id) as sid
            FROM attendance a
            LEFT JOIN sites s2 ON (LOWER(TRIM(s2.name)) = LOWER(TRIM(a.site_name)))
            WHERE a.user_id = ? AND a.date = ?
              AND (a.site_id IS NOT NULL OR s2.id IS NOT NULL)
          `).all(userId, dateStr);
          attendanceSiteIds = rows.map(r => r.sid).filter(Boolean);
        } else if (attCols.includes('site_id')) {
          const rows = db.prepare(`
            SELECT DISTINCT a.site_id as sid
            FROM attendance a
            WHERE a.user_id = ? AND a.date = ? AND a.site_id IS NOT NULL
          `).all(userId, dateStr);
          attendanceSiteIds = rows.map(r => r.sid).filter(Boolean);
        }
      }
    } catch (_) {}

    const extraSiteClause = attendanceSiteIds.length > 0
      ? ` OR site_id IN (${attendanceSiteIds.map(() => '?').join(',')})`
      : '';

    const hasPo = !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='purchase_orders'`).get();
    if (hasPo) {
      const sql = `
        SELECT id, site_id, report_date, grand_total_a, grand_total_b, profit_loss,
               hindrances, hindrance_category, approval_status
        FROM dpr
        WHERE report_date = ?
          AND (
            submitted_by = ?
            OR site_id IN (
              SELECT s.id FROM sites s
              LEFT JOIN purchase_orders po ON po.id = s.po_id
              WHERE s.site_engineer_id = ?
                 OR po.site_engineer_id = ?
                 OR (po.site_engineer_ids IS NOT NULL AND (',' || po.site_engineer_ids || ',') LIKE ('%,' || ? || ',%'))
                 OR (po.jr_site_engineer_ids IS NOT NULL AND (',' || po.jr_site_engineer_ids || ',') LIKE ('%,' || ? || ',%'))
                 OR (s.site_engineer_ids IS NOT NULL AND (',' || s.site_engineer_ids || ',') LIKE ('%,' || ? || ',%'))
            )
            ${extraSiteClause}
          )
          AND (is_planned_template IS NULL OR is_planned_template = 0)
        ORDER BY id DESC LIMIT 1
      `;
      const params = [dateStr, userId, userId, userId, String(userId), String(userId), String(userId), ...attendanceSiteIds];
      return db.prepare(sql).get(...params) || null;
    } else {
      const sql = `
        SELECT id, site_id, report_date, grand_total_a, grand_total_b, profit_loss,
               hindrances, hindrance_category, approval_status
        FROM dpr
        WHERE report_date = ?
          AND (
            submitted_by = ?
            OR site_id IN (
              SELECT s.id FROM sites s
              WHERE s.site_engineer_id = ?
                 OR (s.site_engineer_ids IS NOT NULL AND (',' || s.site_engineer_ids || ',') LIKE ('%,' || ? || ',%'))
            )
            ${extraSiteClause}
          )
          AND (is_planned_template IS NULL OR is_planned_template = 0)
        ORDER BY id DESC LIMIT 1
      `;
      const params = [dateStr, userId, userId, String(userId), ...attendanceSiteIds];
      return db.prepare(sql).get(...params) || null;
    }
  } catch (_) {
    return null;
  }
}

/**
 * Evaluates whether a Site Engineer's overtime or Sunday attendance qualifies
 * based on DPR presence and profitability.
 */
function evaluateSiteEngineerDpr(db, userId, dateStr, isSunday, rawTotalHours) {
  const requiresDpr = isSunday || rawTotalHours > 10;
  if (!requiresDpr) {
    return {
      requiresDpr: false,
      ot_status: 'standard',
      dpr_id: null,
      dpr_profit_loss: null,
      ot_rejection_reason: null,
      shouldClampToShiftEnd: false,
      message: null,
    };
  }

  try {
    // Look for submitted DPR for today
    const dpr = findSiteEngineerDpr(db, userId, dateStr);

    if (!dpr) {
      if (isSunday) {
        return {
          requiresDpr: true,
          ot_status: 'rejected_no_dpr',
          dpr_id: null,
          dpr_profit_loss: null,
          ot_rejection_reason: 'Sunday double attendance disallowed: Mandatory DPR not filed on Sunday (TSK-1020)',
          shouldClampToShiftEnd: false,
          message: 'Sunday double attendance disallowed: No DPR filed for today.',
        };
      } else {
        // Weekday > 10 hours
        return {
          requiresDpr: true,
          ot_status: 'clamped_no_dpr',
          dpr_id: null,
          dpr_profit_loss: null,
          ot_rejection_reason: 'Clamped to 6:00 PM shift end: Mandatory DPR not filed for overtime (>10h) work (TK-01466)',
          shouldClampToShiftEnd: true,
          message: 'Punch-out clamped to 6:00 PM (no DPR filed for overtime work).',
        };
      }
    }

    // DPR exists! Evaluate profit
    const profit = Number(dpr.profit_loss != null ? dpr.profit_loss : ((dpr.grand_total_a || 0) - (dpr.grand_total_b || 0)));
    const isProfit = profit > 0;

    if (isProfit) {
      return {
        requiresDpr: true,
        ot_status: 'approved',
        dpr_id: dpr.id,
        dpr_profit_loss: profit,
        ot_rejection_reason: null,
        shouldClampToShiftEnd: false,
        message: `${isSunday ? 'Sunday double pay' : 'Overtime'} approved via profitable DPR #${dpr.id} (Profit: ₹${profit}).`,
      };
    }

    // In loss (<= 0): Check for legitimate non-revenue hindrance category
    const cat = String(dpr.hindrance_category || '').toLowerCase();
    const reason = String(dpr.hindrances || '').toLowerCase();
    const isLegitimateException =
      cat.includes('material') || cat.includes('machine') || cat.includes('site clearance') ||
      cat.includes('testing') || reason.includes('unloading') || reason.includes('testing') ||
      reason.includes('flushing') || reason.includes('clearance');

    if (isLegitimateException) {
      return {
        requiresDpr: true,
        ot_status: 'pending_pm',
        dpr_id: dpr.id,
        dpr_profit_loss: profit,
        ot_rejection_reason: `Pending PM Approval: DPR #${dpr.id} in loss (₹${profit}) due to ${dpr.hindrance_category || 'site hindrance'}`,
        shouldClampToShiftEnd: false,
        message: `${isSunday ? 'Sunday bonus' : 'Overtime'} pending PM approval: DPR #${dpr.id} reported loss of ₹${profit} (${dpr.hindrance_category || 'hindrance'}).`,
      };
    }

    // Unjustified loss
    if (isSunday) {
      return {
        requiresDpr: true,
        ot_status: 'rejected_loss',
        dpr_id: dpr.id,
        dpr_profit_loss: profit,
        ot_rejection_reason: `Sunday double attendance disallowed: DPR #${dpr.id} operated at a loss (₹${profit}) without valid hindrance.`,
        shouldClampToShiftEnd: false,
        message: `Sunday double pay disallowed: DPR #${dpr.id} in loss (₹${profit}).`,
      };
    } else {
      return {
        requiresDpr: true,
        ot_status: 'rejected_loss',
        dpr_id: dpr.id,
        dpr_profit_loss: profit,
        ot_rejection_reason: `Overtime rejected: DPR #${dpr.id} operated at a loss (₹${profit}) without valid hindrance. Clamped to 6:00 PM.`,
        shouldClampToShiftEnd: true,
        message: `Shift clamped to 6:00 PM: DPR #${dpr.id} in loss (₹${profit}).`,
      };
    }
  } catch (err) {
    console.error('[evaluateSiteEngineerDpr] error evaluating DPR:', err.message);
    return {
      requiresDpr: false,
      ot_status: 'standard',
      dpr_id: null,
      dpr_profit_loss: null,
      ot_rejection_reason: null,
      shouldClampToShiftEnd: false,
      message: null,
    };
  }
}

/**
 * When a DPR is submitted or re-saved, sync today's attendance records for the site engineer(s)
 * so if they punched out before submitting the DPR, their OT / Sunday status is updated seamlessly.
 */
function syncAttendanceWithDpr(db, dprId) {
  if (!dprId) return;
  try {
    const dpr = db.prepare(`SELECT * FROM dpr WHERE id = ?`).get(dprId);
    if (!dpr || !dpr.report_date) return;

    // Find candidate engineers for this DPR
    let candidates = [];
    const hasPo = !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='purchase_orders'`).get();
    if (hasPo) {
      candidates = db.prepare(`
        SELECT DISTINCT u.id
        FROM users u
        LEFT JOIN sites s ON s.id = ?
        LEFT JOIN purchase_orders po ON po.id = s.po_id
        WHERE u.id = ?
           OR s.site_engineer_id = u.id
           OR po.site_engineer_id = u.id
           OR (po.site_engineer_ids IS NOT NULL AND (',' || po.site_engineer_ids || ',') LIKE ('%,' || u.id || ',%'))
           OR (po.jr_site_engineer_ids IS NOT NULL AND (',' || po.jr_site_engineer_ids || ',') LIKE ('%,' || u.id || ',%'))
           OR (s.site_engineer_ids IS NOT NULL AND (',' || s.site_engineer_ids || ',') LIKE ('%,' || u.id || ',%'))
      `).all(dpr.site_id, dpr.submitted_by);
    } else {
      candidates = db.prepare(`
        SELECT DISTINCT u.id
        FROM users u
        LEFT JOIN sites s ON s.id = ?
        WHERE u.id = ?
           OR s.site_engineer_id = u.id
           OR (s.site_engineer_ids IS NOT NULL AND (',' || s.site_engineer_ids || ',') LIKE ('%,' || u.id || ',%'))
      `).all(dpr.site_id, dpr.submitted_by);
    }

    const isSun = new Date(dpr.report_date + 'T12:00:00Z').getUTCDay() === 0;

    for (const cand of candidates) {
      if (!isSiteEngineer(db, cand.id)) continue;
      const att = db.prepare(`SELECT * FROM attendance WHERE user_id = ? AND date = ?`).get(cand.id, dpr.report_date);
      if (!att || !att.punch_in_time || !att.punch_out_time) continue;

      // Re-evaluate
      const rawHours = att.original_punch_out && att.punch_in_time
        ? Math.round((new Date(att.original_punch_out) - new Date(att.punch_in_time)) / (1000 * 60 * 60) * 100) / 100
        : Number(att.total_hours || 0);

      const evalRes = evaluateSiteEngineerDpr(db, cand.id, dpr.report_date, isSun, rawHours);
      if (evalRes.ot_status === 'approved') {
        const restoredPunchOut = att.original_punch_out || att.punch_out_time;
        const restoredHours = Math.round((new Date(restoredPunchOut) - new Date(att.punch_in_time)) / (1000 * 60 * 60) * 100) / 100;
        db.prepare(`
          UPDATE attendance
          SET ot_status = 'approved',
              dpr_id = ?,
              dpr_profit_loss = ?,
              ot_rejection_reason = NULL,
              punch_out_time = ?,
              total_hours = ?
          WHERE id = ?
        `).run(dpr.id, evalRes.dpr_profit_loss, restoredPunchOut, restoredHours, att.id);
      } else if (evalRes.ot_status === 'pending_pm') {
        db.prepare(`
          UPDATE attendance
          SET ot_status = 'pending_pm',
              dpr_id = ?,
              dpr_profit_loss = ?,
              ot_rejection_reason = ?
          WHERE id = ?
        `).run(dpr.id, evalRes.dpr_profit_loss, evalRes.ot_rejection_reason, att.id);
      }
    }
  } catch (e) {
    console.warn('[syncAttendanceWithDpr] error:', e.message);
  }
}

module.exports = {
  runSiteEngineerAttendanceMigrations,
  isSiteEngineer,
  findSiteEngineerDpr,
  evaluateSiteEngineerDpr,
  syncAttendanceWithDpr,
};


