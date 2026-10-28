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
}

/**
 * Checks whether a given user is classified as a Site Engineer / Site Staff.
 * Criteria:
 *   1. Assigned as site_engineer_id (or in site_engineer_ids) on any active/all site
 *   2. User department is 'Site Operations' or role is 'site_engineer'
 *   3. Employee roster is 'early' (9:00 AM - 6:00 PM site staff)
 *   4. Employee designation or department contains 'site'
 */
function isSiteEngineer(db, userId) {
  if (!userId || !db) return false;
  try {
    // 1. Check sites assignment
    try {
      const siteAssigned = db.prepare(`
        SELECT 1 FROM sites 
        WHERE site_engineer_id = ? 
           OR (site_engineer_ids IS NOT NULL AND (',' || site_engineer_ids || ',') LIKE ('%,' || ? || ',%'))
        LIMIT 1
      `).get(userId, String(userId));
      if (siteAssigned) return true;
    } catch (_) {}

    // 2. Check users department / role
    try {
      const user = db.prepare(`SELECT role, department FROM users WHERE id = ?`).get(userId);
      if (user) {
        const uRole = String(user.role || '').toLowerCase();
        const uDept = String(user.department || '').toLowerCase();
        if (uRole === 'site_engineer' || uDept.includes('site')) return true;
      }
    } catch (_) {}

    // 3. Check employees roster & designation
    try {
      const emp = db.prepare(`SELECT roster, designation, department, is_field_employee FROM employees WHERE user_id = ?`).get(userId);
      if (emp) {
        if (emp.roster === 'early') return true;
        if (emp.is_field_employee === 1) return true;
        const desig = String(emp.designation || '').toLowerCase();
        const dept = String(emp.department || '').toLowerCase();
        if (desig.includes('site') || dept.includes('site')) return true;
      }
    } catch (_) {}
  } catch (_) {}
  return false;
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

  // Look for submitted DPR for today
  const dpr = db.prepare(`
    SELECT id, site_id, report_date, grand_total_a, grand_total_b, profit_loss,
           hindrances, hindrance_category, approval_status
    FROM dpr
    WHERE report_date = ?
      AND (
        submitted_by = ?
        OR site_id IN (
          SELECT id FROM sites
          WHERE site_engineer_id = ?
             OR (site_engineer_ids IS NOT NULL AND (',' || site_engineer_ids || ',') LIKE ('%,' || ? || ',%'))
        )
      )
      AND (is_planned_template IS NULL OR is_planned_template = 0)
    ORDER BY id DESC LIMIT 1
  `).get(dateStr, userId, userId, String(userId));

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
    const candidates = db.prepare(`
      SELECT DISTINCT u.id
      FROM users u
      LEFT JOIN sites s ON s.id = ?
      WHERE u.id = ?
         OR s.site_engineer_id = u.id
         OR (s.site_engineer_ids IS NOT NULL AND (',' || s.site_engineer_ids || ',') LIKE ('%,' || u.id || ',%'))
    `).all(dpr.site_id, dpr.submitted_by);

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
  evaluateSiteEngineerDpr,
  syncAttendanceWithDpr,
};

