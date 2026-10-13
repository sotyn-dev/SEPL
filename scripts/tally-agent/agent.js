/**
 * SEPL Tally Sync Background Agent
 * ----------------------------------------------------
 * Runs on the Main Tally PC / Server in the office.
 * Communicates with Tally on local port 9000 via XML,
 * extracts newly added/modified vouchers, and pushes them
 * over HTTPS to the SEPL Cloud ERP.
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const xml2js = require('xml2js');

const CONFIG_FILE = path.join(__dirname, 'config.json');
const STATE_FILE = path.join(__dirname, 'sync_state.json');

// Load config
let config = {
  tallyUrl: 'http://localhost:9000',
  erpBaseUrl: 'https://securederp.in/api/tally-sync',
  apiToken: '',
  companyName: 'SEPL',
  syncIntervalSeconds: 120,
};

if (fs.existsSync(CONFIG_FILE)) {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    config = { ...config, ...raw };
  } catch (e) {
    console.error('[Config] Failed to parse config.json:', e.message);
  }
}

// Persistent sync state (last alter IDs)
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (_) {}
  return { lastPurchaseAlterId: 0, lastPaymentAlterId: 0 };
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    console.error('[State] Failed to save sync_state.json:', e.message);
  }
}

function formatTallyDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (/^\d{8}$/.test(s)) {
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }
  return s;
}

// Tally XML Query Builder
function buildTallyQuery(voucherTypeName) {
  return `
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Export Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <EXPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Voucher Register</REPORTNAME>
        <STATICVARIABLES>
          <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
          <VOUCHERTYPENAME>${voucherTypeName}</VOUCHERTYPENAME>
        </STATICVARIABLES>
      </REQUESTDESC>
    </EXPORTDATA>
  </BODY>
</ENVELOPE>`.trim();
}

async function fetchTallyXml(voucherTypeName) {
  const query = buildTallyQuery(voucherTypeName);
  const response = await axios.post(config.tallyUrl, query, {
    headers: { 'Content-Type': 'text/xml' },
    timeout: 15000,
  });

  const parsed = await xml2js.parseStringPromise(response.data, {
    explicitArray: false,
    trim: true,
  });

  const rawMessages =
    parsed?.ENVELOPE?.BODY?.IMPORTDATA?.REQUESTDATA?.TALLYMESSAGE || [];
  return Array.isArray(rawMessages) ? rawMessages : [rawMessages];
}

// 1. Sync Purchase Vouchers
async function syncPurchaseVouchers(state) {
  const messages = await fetchTallyXml('Purchase');
  const toSync = [];
  let highestAlterId = state.lastPurchaseAlterId || 0;

  for (const m of messages) {
    const v = m?.VOUCHER;
    if (!v) continue;

    const alterId = Number(v.ALTERID || 0);
    if (alterId <= (state.lastPurchaseAlterId || 0)) continue;
    if (alterId > highestAlterId) highestAlterId = alterId;

    const billNumber = v.REFERENCE || v.VOUCHERNUMBER;
    const vendorName = v.PARTYLEDGERNAME || v.PARTYNAME;
    const rawAmount = Math.abs(Number(v.AMOUNT || 0));
    const billDate = formatTallyDate(v.DATE);

    if (!billNumber || !vendorName || rawAmount <= 0) continue;

    toSync.push({
      tally_guid: v.GUID,
      alter_id: alterId,
      voucher_type: v.VOUCHERTYPENAME || 'Purchase',
      bill_number: billNumber,
      bill_date: billDate,
      vendor_name: vendorName,
      vendor_gstin: v.PARTYGSTIN || null,
      bill_amount: rawAmount,
      narration: v.NARRATION || '',
      cost_centre: v.COSTCENTRENAME || '',
      company_name: config.companyName,
    });
  }

  if (toSync.length === 0) {
    return 0;
  }

  console.log(`[Purchases] Found ${toSync.length} new/updated voucher(s). Pushing to ERP...`);

  const res = await axios.post(
    `${config.erpBaseUrl}/vouchers`,
    { vouchers: toSync, company_name: config.companyName },
    {
      headers: {
        'Content-Type': 'application/json',
        'X-Tally-Token': config.apiToken,
      },
      timeout: 20000,
    }
  );

  console.log(`[Purchases] ERP Response:`, res.data);
  state.lastPurchaseAlterId = highestAlterId;
  saveState(state);
  return toSync.length;
}

// 2. Sync Payment Vouchers
async function syncPaymentVouchers(state) {
  const messages = await fetchTallyXml('Payment');
  const toSync = [];
  let highestAlterId = state.lastPaymentAlterId || 0;

  for (const m of messages) {
    const v = m?.VOUCHER;
    if (!v) continue;

    const alterId = Number(v.ALTERID || 0);
    if (alterId <= (state.lastPaymentAlterId || 0)) continue;
    if (alterId > highestAlterId) highestAlterId = alterId;

    const vendorName = v.PARTYLEDGERNAME || v.PARTYNAME;
    const rawAmount = Math.abs(Number(v.AMOUNT || 0));
    const payDate = formatTallyDate(v.DATE);
    const billRef = v.REFERENCE || '';

    // Check bank allocation for UTR/cheque if present
    const bankAlloc = v.ALLLEDGERENTRIES_LIST?.BANKALLOCATIONS_LIST;
    const utr = bankAlloc?.INSTRUMENTNUMBER || null;

    if (!vendorName || rawAmount <= 0) continue;

    toSync.push({
      tally_guid: v.GUID,
      alter_id: alterId,
      payment_date: payDate,
      vendor_name: vendorName,
      amount: rawAmount,
      bill_ref: billRef,
      utr_ref: utr,
      narration: v.NARRATION || '',
      company_name: config.companyName,
    });
  }

  if (toSync.length === 0) {
    return 0;
  }

  console.log(`[Payments] Found ${toSync.length} new payment(s). Pushing to ERP...`);

  const res = await axios.post(
    `${config.erpBaseUrl}/payments`,
    { payments: toSync, company_name: config.companyName },
    {
      headers: {
        'Content-Type': 'application/json',
        'X-Tally-Token': config.apiToken,
      },
      timeout: 20000,
    }
  );

  console.log(`[Payments] ERP Response:`, res.data);
  state.lastPaymentAlterId = highestAlterId;
  saveState(state);
  return toSync.length;
}

async function runCycle() {
  const state = loadState();
  const now = new Date().toLocaleTimeString();

  try {
    const pCount = await syncPurchaseVouchers(state);
    const payCount = await syncPaymentVouchers(state);
    if (pCount === 0 && payCount === 0) {
      console.log(`[${now}] No new Tally vouchers to sync. Next check in ${config.syncIntervalSeconds}s.`);
    }
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      console.warn(`[${now}] Tally not reachable at ${config.tallyUrl}. Is Tally open with Port 9000 enabled?`);
    } else if (err.response?.status === 401) {
      console.error(`[${now}] Authentication Error: Invalid X-Tally-Token in config.json.`);
    } else {
      console.error(`[${now}] Sync cycle error:`, err.message);
    }
  }
}

// Start agent loop
console.log('============================================');
console.log('   SEPL TALLY -> ERP SYNC AGENT STARTED    ');
console.log('============================================');
console.log(`Tally URL:    ${config.tallyUrl}`);
console.log(`ERP Endpoint: ${config.erpBaseUrl}`);
console.log(`Interval:     ${config.syncIntervalSeconds} seconds`);
console.log('--------------------------------------------');

runCycle();
setInterval(runCycle, Math.max(30, config.syncIntervalSeconds) * 1000);
