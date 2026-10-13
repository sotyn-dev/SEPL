// Tally -> ERP One-Way Synchronization Route (TSK-0826)
//
// Ingests Purchase and Payment vouchers pushed from the on-premise
// Tally Sync Agent. Idempotent by Tally GUID and (vendor_name, bill_number).

const express = require('express');
const crypto = require('crypto');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const sla = require('../lib/tallySla');
const { ensureTallySyncSchema } = require('../lib/tallySyncSchema');

const router = express.Router();

// Ensure columns and sync logs table exist
try { ensureTallySyncSchema(getDb()); } catch (_) { }

const TOKEN_SETTING_KEY = 'tally_sync_token';
const DEFAULT_FALLBACK_TOKEN = 'sepl_tally_sync_secret_2026';

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// Read or auto-initialize persistent sync token in app_settings
function getSyncToken(db) {
  if (process.env.TALLY_SYNC_TOKEN) {
    return process.env.TALLY_SYNC_TOKEN.trim();
  }
  try {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(TOKEN_SETTING_KEY);
    if (row?.value) return row.value.trim();

    // Auto-generate on first use
    const generated = 'sepl_' + crypto.randomBytes(16).toString('hex');
    db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(TOKEN_SETTING_KEY, generated);
    return generated;
  } catch (e) {
    return DEFAULT_FALLBACK_TOKEN;
  }
}

// Token verification middleware for Tally client
function verifyTallyToken(req, res, next) {
  const clientToken = req.headers['x-tally-token'] || req.query.token;
  if (!clientToken) {
    return res.status(401).json({ error: 'Missing X-Tally-Token header' });
  }

  const db = getDb();
  const validToken = getSyncToken(db);

  if (String(clientToken).trim() !== validToken) {
    return res.status(401).json({ error: 'Invalid X-Tally-Token' });
  }
  next();
}

function nextRegisterNo(db) {
  const yr = new Date().getUTCFullYear();
  const last = db.prepare(
    `SELECT register_no FROM tally_bills WHERE register_no LIKE ? ORDER BY id DESC LIMIT 1`
  ).get(`TB-${yr}-%`);
  const n = last ? (parseInt(String(last.register_no).split('-').pop(), 10) || 0) + 1 : 1;
  return `TB-${yr}-${String(n).padStart(4, '0')}`;
}

// Try matching a vendor by GSTIN or Name
function resolveVendor(db, vendorName, gstin) {
  if (gstin && String(gstin).trim()) {
    const byGstin = db.prepare(
      `SELECT id, name FROM vendors WHERE LOWER(TRIM(COALESCE(gst_number,''))) = LOWER(TRIM(?)) LIMIT 1`
    ).get(String(gstin).trim());
    if (byGstin) return byGstin;
  }

  if (vendorName && String(vendorName).trim()) {
    const byName = db.prepare(
      `SELECT id, name FROM vendors WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) LIMIT 1`
    ).get(String(vendorName).trim());
    if (byName) return byName;
  }
  return null;
}

// Try matching project from narration or cost centre
function resolveProject(db, costCentre, narration) {
  const searchStr = `${costCentre || ''} ${narration || ''}`.trim().toLowerCase();
  if (!searchStr) return null;

  const projects = db.prepare(
    `SELECT id, lead_no, project_name, client_name FROM business_book WHERE status != 'lost' LIMIT 500`
  ).all();

  for (const p of projects) {
    if (p.lead_no && searchStr.includes(p.lead_no.toLowerCase())) {
      return { id: p.id, name: p.project_name || p.client_name || p.lead_no };
    }
    if (p.project_name && p.project_name.length > 3 && searchStr.includes(p.project_name.toLowerCase())) {
      return { id: p.id, name: p.project_name };
    }
  }
  return null;
}

// Record an audit trail entry on a tally bill
function auditSync(db, billId, action, note, changes = []) {
  try {
    const ins = db.prepare(`
      INSERT INTO tally_bill_audit (bill_id, action, field, old_value, new_value, note, user_id, user_name)
      VALUES (?, ?, ?, ?, ?, ?, NULL, 'Tally Sync Agent')
    `);
    if (changes.length) {
      for (const c of changes) {
        ins.run(billId, action, c.field, String(c.old ?? ''), String(c.new ?? ''), note);
      }
    } else {
      ins.run(billId, action, 'status', null, null, note);
    }
  } catch (_) { }
}

// ─── 1. Bulk Ingest Purchase / Expense Vouchers ────────────────────────
router.post('/vouchers', verifyTallyToken, (req, res) => {
  const db = getDb();
  const { vouchers, company_name } = req.body || {};

  if (!Array.isArray(vouchers) || vouchers.length === 0) {
    return res.json({ message: 'No vouchers in payload', added: 0, updated: 0, skipped: 0 });
  }

  let added = 0;
  let updated = 0;
  let skipped = 0;
  let maxAlterId = 0;

  const ctx = sla.makeCtx(db);
  const nowMs = Date.now();
  const t0 = sla.toSqlUtc(nowMs);
  const t1Due = sla.toSqlUtc(sla.addBusinessMinutes(nowMs, ctx.cfg.stage2_days * ctx.perDay, ctx));

  const findByGuid = db.prepare(`SELECT * FROM tally_bills WHERE tally_guid = ?`);
  const findByNameAndNum = db.prepare(`
    SELECT * FROM tally_bills
     WHERE LOWER(TRIM(vendor_name)) = LOWER(TRIM(?))
       AND LOWER(TRIM(bill_number)) = LOWER(TRIM(?))
  `);

  const insertStmt = db.prepare(`
    INSERT INTO tally_bills (
      register_no, project_id, project_name, category, vendor_id, vendor_name,
      bill_number, bill_date, bill_amount, remarks, status,
      t0_uploaded_at, t1_due_at, tally_guid, tally_alter_id,
      is_tally_synced, tally_voucher_type, tally_company, tally_party_gstin
    ) VALUES (
      ?, ?, ?, 'material', ?, ?,
      ?, ?, ?, ?, 'pending_task_creation',
      ?, ?, ?, ?,
      1, ?, ?, ?
    )
  `);

  const updateStmt = db.prepare(`
    UPDATE tally_bills
       SET bill_amount = ?, bill_date = ?, remarks = COALESCE(?, remarks),
           tally_alter_id = ?, tally_company = COALESCE(?, tally_company),
           tally_party_gstin = COALESCE(?, tally_party_gstin),
           is_tally_synced = 1, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `);

  try {
    db.transaction(() => {
      for (const v of vouchers) {
        const alterId = Number(v.alter_id || 0);
        if (alterId > maxAlterId) maxAlterId = alterId;

        const billNumber = String(v.bill_number || '').trim();
        const vendorName = String(v.vendor_name || '').trim();
        const billAmount = round2(Math.abs(Number(v.bill_amount) || 0));
        const billDate = String(v.bill_date || '').trim().slice(0, 10);
        const guid = v.tally_guid ? String(v.tally_guid).trim() : null;
        const gstin = v.vendor_gstin ? String(v.vendor_gstin).trim() : null;
        const vchType = String(v.voucher_type || 'Purchase').trim();
        const remarks = (v.narration || '').trim() || null;
        const company = (company_name || v.company_name || '').trim() || null;

        if (!billNumber || !vendorName || billAmount <= 0 || !billDate) {
          skipped++;
          continue;
        }

        // Check if existing by GUID or (vendor_name, bill_number)
        let existing = guid ? findByGuid.get(guid) : null;
        if (!existing) {
          existing = findByNameAndNum.get(vendorName, billNumber);
        }

        if (existing) {
          // If locked or already paid/closed, do not overwrite financials
          if (existing.locked || ['closed', 'rejected'].includes(existing.status)) {
            // Still associate the GUID if missing
            if (guid && !existing.tally_guid) {
              db.prepare('UPDATE tally_bills SET tally_guid = ?, is_tally_synced = 1 WHERE id = ?').run(guid, existing.id);
            }
            skipped++;
            continue;
          }

          // Check if changed
          const changes = [];
          if (round2(existing.bill_amount) !== billAmount) {
            changes.push({ field: 'bill_amount', old: existing.bill_amount, new: billAmount });
          }
          if (String(existing.bill_date) !== billDate) {
            changes.push({ field: 'bill_date', old: existing.bill_date, new: billDate });
          }

          if (changes.length > 0 || (guid && !existing.tally_guid)) {
            updateStmt.run(billAmount, billDate, remarks, alterId, company, gstin, existing.id);
            if (guid && !existing.tally_guid) {
              db.prepare('UPDATE tally_bills SET tally_guid = ? WHERE id = ?').run(guid, existing.id);
            }
            auditSync(db, existing.id, 'tally_update', 'Voucher updated from Tally sync', changes);
            updated++;
          } else {
            skipped++;
          }
          continue;
        }

        // New voucher: resolve vendor and project
        const vendor = resolveVendor(db, vendorName, gstin);
        const project = resolveProject(db, v.cost_centre, remarks);
        const regNo = nextRegisterNo(db);

        const info = insertStmt.run(
          regNo,
          project ? project.id : null,
          project ? project.name : null,
          vendor ? vendor.id : null,
          vendor ? vendor.name : vendorName,
          billNumber,
          billDate,
          billAmount,
          remarks,
          t0,
          t1Due,
          guid,
          alterId,
          vchType,
          company,
          gstin
        );

        auditSync(db, info.lastInsertRowid, 'tally_create', `Synced from Tally (${vchType} Voucher #${billNumber})`);
        added++;
      }

      // Record log
      db.prepare(`
        INSERT INTO tally_sync_logs (
          sync_type, vouchers_received, vouchers_added, vouchers_updated,
          vouchers_skipped, last_alter_id, company_name, status, ip_address
        ) VALUES ('vouchers', ?, ?, ?, ?, ?, ?, 'success', ?)
      `).run(vouchers.length, added, updated, skipped, maxAlterId, company_name || null, req.ip || null);
    })();

    res.json({
      success: true,
      received: vouchers.length,
      added,
      updated,
      skipped,
      max_alter_id: maxAlterId
    });
  } catch (err) {
    console.error('[tally-sync] Vouchers sync failed:', err);
    try {
      db.prepare(`
        INSERT INTO tally_sync_logs (
          sync_type, vouchers_received, status, error_message, company_name, ip_address
        ) VALUES ('vouchers', ?, 'error', ?, ?, ?)
      `).run(vouchers.length, err.message, company_name || null, req.ip || null);
    } catch (_) { }

    res.status(500).json({ error: 'Sync failed: ' + err.message });
  }
});

// ─── 2. Bulk Ingest Payment Vouchers ──────────────────────────────────
router.post('/payments', verifyTallyToken, (req, res) => {
  const db = getDb();
  const { payments, company_name } = req.body || {};

  if (!Array.isArray(payments) || payments.length === 0) {
    return res.json({ message: 'No payments in payload', matched: 0, added: 0, skipped: 0 });
  }

  let matchedCount = 0;
  let addedCount = 0;
  let skippedCount = 0;
  let maxAlterId = 0;

  const findBill = db.prepare(`
    SELECT * FROM tally_bills
     WHERE LOWER(TRIM(bill_number)) = LOWER(TRIM(?))
       AND (
         LOWER(TRIM(vendor_name)) = LOWER(TRIM(?))
         OR LOWER(TRIM(vendor_name)) LIKE '%' || LOWER(TRIM(?)) || '%'
         OR LOWER(TRIM(?)) LIKE '%' || LOWER(TRIM(vendor_name)) || '%'
       )
     ORDER BY id DESC LIMIT 1
  `);

  const findBillByNumberOnly = db.prepare(`
    SELECT * FROM tally_bills
     WHERE LOWER(TRIM(bill_number)) = LOWER(TRIM(?))
     ORDER BY id DESC LIMIT 1
  `);

  const checkPaymentExists = db.prepare(`
    SELECT id FROM tally_bill_payments
     WHERE bill_id = ?
       AND (
         (utr_ref IS NOT NULL AND TRIM(utr_ref) = TRIM(?))
         OR (received_date = ? AND ABS(amount - ?) < 0.01)
       )
  `);

  const insertPayment = db.prepare(`
    INSERT INTO tally_bill_payments (bill_id, received_date, amount, utr_ref, remarks)
    VALUES (?, ?, ?, ?, ?)
  `);

  try {
    db.transaction(() => {
      for (const p of payments) {
        const alterId = Number(p.alter_id || 0);
        if (alterId > maxAlterId) maxAlterId = alterId;

        const billRef = String(p.bill_ref || '').trim();
        const vendorName = String(p.vendor_name || '').trim();
        const payAmount = round2(Math.abs(Number(p.amount) || 0));
        const payDate = String(p.payment_date || '').trim().slice(0, 10);
        const utr = String(p.utr_ref || p.instrument_number || '').trim() || null;
        const remarks = (p.remarks || p.narration || 'Synced from Tally Payment Voucher').trim();

        if (payAmount <= 0 || !payDate) {
          skippedCount++;
          continue;
        }

        let bill = null;
        if (billRef) {
          bill = vendorName ? findBill.get(billRef, vendorName, vendorName, vendorName) : null;
          if (!bill) {
            bill = findBillByNumberOnly.get(billRef);
          }
        }

        if (!bill) {
          skippedCount++;
          continue;
        }

        matchedCount++;

        // Deduplication for payment
        const alreadyPaid = checkPaymentExists.get(bill.id, utr || '', payDate, payAmount);
        if (alreadyPaid) {
          skippedCount++;
          continue;
        }

        // Record the payment
        insertPayment.run(bill.id, payDate, payAmount, utr, remarks);
        addedCount++;

        // Recalculate bill total received and update status
        const totalPaidRow = db.prepare(
          `SELECT COALESCE(SUM(amount), 0) AS total FROM tally_bill_payments WHERE bill_id = ?`
        ).get(bill.id);
        const newTotalPaid = round2(totalPaidRow?.total || 0);
        const targetAmount = bill.approved_amount != null ? round2(bill.approved_amount) : round2(bill.bill_amount);

        let newStatus = bill.status;
        let t4ClosedAt = bill.t4_closed_at;

        if (targetAmount > 0 && newTotalPaid >= targetAmount) {
          newStatus = 'closed';
          if (!t4ClosedAt) t4ClosedAt = sla.toSqlUtc(Date.now());
        } else if (newTotalPaid > 0 && !['closed', 'rejected', 'on_hold'].includes(bill.status)) {
          newStatus = 'partially_paid';
        }

        db.prepare(`
          UPDATE tally_bills
             SET amount_received = ?, status = ?, t4_closed_at = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?
        `).run(newTotalPaid, newStatus, t4ClosedAt, bill.id);

        auditSync(
          db,
          bill.id,
          'payment',
          `Payment of ₹${payAmount} synced from Tally (UTR: ${utr || 'N/A'}). Total paid: ₹${newTotalPaid}`,
          [{ field: 'amount_received', old: bill.amount_received, new: newTotalPaid }]
        );
      }

      db.prepare(`
        INSERT INTO tally_sync_logs (
          sync_type, vouchers_received, vouchers_added, vouchers_updated,
          vouchers_skipped, last_alter_id, company_name, status, ip_address
        ) VALUES ('payments', ?, ?, ?, ?, ?, ?, 'success', ?)
      `).run(payments.length, addedCount, matchedCount, skippedCount, maxAlterId, company_name || null, req.ip || null);
    })();

    res.json({
      success: true,
      received: payments.length,
      matched: matchedCount,
      added: addedCount,
      skipped: skippedCount,
      max_alter_id: maxAlterId
    });
  } catch (err) {
    console.error('[tally-sync] Payments sync failed:', err);
    res.status(500).json({ error: 'Payment sync failed: ' + err.message });
  }
});

// ─── 3. Sync Status & Health (For ERP Admin & Settings) ────────────────
router.get('/status', authMiddleware, requirePermission('tally_bills', 'view'), (req, res) => {
  try {
    const db = getDb();
    const token = getSyncToken(db);

    const counts = db.prepare(`
      SELECT
        COUNT(*) AS total_bills,
        SUM(CASE WHEN is_tally_synced = 1 THEN 1 ELSE 0 END) AS tally_synced_bills,
        SUM(CASE WHEN is_tally_synced = 1 AND status = 'closed' THEN 1 ELSE 0 END) AS closed_synced_bills
      FROM tally_bills
    `).get();

    const lastLog = db.prepare(`
      SELECT * FROM tally_sync_logs ORDER BY id DESC LIMIT 1
    `).get();

    const recentLogs = db.prepare(`
      SELECT * FROM tally_sync_logs ORDER BY id DESC LIMIT 15
    `).all();

    res.json({
      token,
      stats: {
        total_bills: counts.total_bills || 0,
        tally_synced_bills: counts.tally_synced_bills || 0,
        closed_synced_bills: counts.closed_synced_bills || 0,
      },
      last_sync: lastLog || null,
      recent_logs: recentLogs || [],
    });
  } catch (err) {
    console.error('[tally-sync] status failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── 4. Regenerate Sync Token (Admin Only) ────────────────────────────
router.post('/token/regenerate', authMiddleware, (req, res) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  try {
    const db = getDb();
    const newToken = 'sepl_' + crypto.randomBytes(16).toString('hex');
    db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(TOKEN_SETTING_KEY, newToken);
    res.json({ success: true, token: newToken });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
