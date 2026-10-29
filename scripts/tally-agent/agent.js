/**
 * SEPL Tally Sync Background Agent (Zero Dependencies)
 * ----------------------------------------------------
 * Runs on the Main Tally Host PC in the office.
 * Communicates with Tally on local port 9000 via XML,
 * extracts newly added/modified vouchers (Purchases, Sales, Bank),
 * parses full line-item details (name, description, quantity, rate, unit, disc, amount),
 * taxes, and pushes them over HTTPS to the SEPL Cloud ERP.
 *
 * ZERO EXTERNAL DEPENDENCIES: Compatible with Node.js v6.0+ (ES5)
 */

var http = require('http');
var https = require('https');
var url = require('url');
var fs = require('fs');
var path = require('path');

// Allow legacy Node.js engines (v6.10 on Host PC) to communicate with modern HTTPS SSL
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

var CONFIG_FILE = path.join(__dirname, 'config.json');
var STATE_FILE = path.join(__dirname, 'sync_state.json');

// Default configuration
var config = {
  tallyUrl: 'http://localhost:9000',
  erpBaseUrl: 'https://securederp.in/api/tally-sync',
  apiToken: 'sepl_5422b039882d8814d20d1c8eacfd9632',
  companyName: 'SECURED ENGINEERS PVT. LTD. - 24-25',
  syncIntervalSeconds: 60,
  fromDate: '1-Apr-2024',
  toDate: '31-Dec-2027',
};

// Load config.json if present
if (fs.existsSync(CONFIG_FILE)) {
  try {
    var raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    for (var k in raw) {
      if (raw.hasOwnProperty(k)) {
        config[k] = raw[k];
      }
    }
  } catch (e) {
    console.error('[Config] Failed to parse config.json:', e.message);
  }
}

// Clean trailing slashes and /vouchers or /payments or /sales
config.erpBaseUrl = String(config.erpBaseUrl || '')
  .replace(/\/+vouchers\/?$/i, '')
  .replace(/\/+sales\/?$/i, '')
  .replace(/\/+bank\/?$/i, '')
  .replace(/\/+payments\/?$/i, '')
  .replace(/\/+$/, '');

// Persistent sync state (independent alter IDs for Purchases, Sales, Bank, Payments)
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      var s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (s) {
        return {
          lastPurchaseAlterId: Number(s.lastPurchaseAlterId || 0),
          lastSalesAlterId: Number(s.lastSalesAlterId || 0),
          lastBankAlterId: Number(s.lastBankAlterId || 0),
          lastPaymentAlterId: Number(s.lastPaymentAlterId || 0)
        };
      }
    }
  } catch (_) { }
  return {
    lastPurchaseAlterId: 0,
    lastSalesAlterId: 0,
    lastBankAlterId: 0,
    lastPaymentAlterId: 0
  };
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    console.error('[State] Failed to save sync_state.json:', e.message);
  }
}

// Parse Tally dates: YYYYMMDD or DD-Mon-YY / DD-Mon-YYYY
function formatTallyDate(raw) {
  if (!raw) return null;
  var s = String(raw).trim();
  if (/^\d{8}$/.test(s)) {
    return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
  }
  var MONTHS = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12'
  };
  var m = /^(\d{1,2})-([a-z]{3})-(\d{2,4})$/i.exec(s);
  if (m) {
    var day = ('0' + m[1]).slice(-2);
    var mon = MONTHS[m[2].toLowerCase()] || '01';
    var yr = m[3];
    if (yr.length === 2) yr = '20' + yr;
    return yr + '-' + mon + '-' + day;
  }
  return s;
}

// Generic HTTP request helper using built-in modules (compatible with Node v6+)
function request(reqUrl, options, postData) {
  return new Promise(function (resolve, reject) {
    var parsedUrl = url.parse(reqUrl);
    var isHttps = parsedUrl.protocol === 'https:';
    var transport = isHttps ? https : http;

    var reqHeaders = {};
    if (options && options.headers) {
      for (var h in options.headers) {
        if (options.headers.hasOwnProperty(h)) {
          reqHeaders[h] = options.headers[h];
        }
      }
    }

    if (postData) {
      reqHeaders['Content-Length'] = Buffer.byteLength(postData, 'utf8');
      if (!reqHeaders['Content-Type']) {
        reqHeaders['Content-Type'] = 'text/xml;charset=utf-8';
      }
    }

    var reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: (parsedUrl.pathname || '/') + (parsedUrl.search || ''),
      method: (options && options.method) || (postData ? 'POST' : 'GET'),
      headers: reqHeaders,
      rejectUnauthorized: false,
    };

    var req = transport.request(reqOptions, function (res) {
      var body = '';
      res.setEncoding('utf8');
      res.on('data', function (chunk) { body += chunk; });
      res.on('end', function () {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ statusCode: res.statusCode, data: body });
        } else {
          var err = new Error('HTTP ' + res.statusCode + ': ' + body);
          err.statusCode = res.statusCode;
          err.body = body;
          reject(err);
        }
      });
    });

    req.on('error', function (err) {
      reject(err);
    });

    req.setTimeout(35000, function () {
      req.abort();
      reject(new Error('Request timed out after 35s'));
    });

    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

// Primary Tally Export Query: Standard Daybook Data Export
function buildDaybookExport(withDates) {
  var xml = [
    '<ENVELOPE>',
    '  <HEADER>',
    '    <VERSION>1</VERSION>',
    '    <TALLYREQUEST>Export</TALLYREQUEST>',
    '    <TYPE>Data</TYPE>',
    '    <ID>Daybook</ID>',
    '  </HEADER>',
    '  <BODY>',
    '    <DESC>',
    '      <STATICVARIABLES>',
    '        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>'
  ];

  if (withDates) {
    xml.push('        <SVFROMDATE TYPE="Date">' + config.fromDate + '</SVFROMDATE>');
    xml.push('        <SVTODATE TYPE="Date">' + config.toDate + '</SVTODATE>');
  }

  xml.push('      </STATICVARIABLES>');
  xml.push('    </DESC>');
  xml.push('  </BODY>');
  xml.push('</ENVELOPE>');

  return xml.join('\r\n');
}

// Traditional Export Data with REPORTNAME Day Book
function buildDayBookReportExport(withDates) {
  var xml = [
    '<ENVELOPE>',
    '  <HEADER>',
    '    <TALLYREQUEST>Export Data</TALLYREQUEST>',
    '  </HEADER>',
    '  <BODY>',
    '    <EXPORTDATA>',
    '      <REQUESTDESC>',
    '        <REPORTNAME>Day Book</REPORTNAME>',
    '        <STATICVARIABLES>',
    '          <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>'
  ];
  if (withDates) {
    xml.push('          <SVFROMDATE TYPE="Date">' + config.fromDate + '</SVFROMDATE>');
    xml.push('          <SVTODATE TYPE="Date">' + config.toDate + '</SVTODATE>');
  }
  xml.push('        </STATICVARIABLES>');
  xml.push('      </REQUESTDESC>');
  xml.push('    </EXPORTDATA>');
  xml.push('  </BODY>');
  xml.push('</ENVELOPE>');
  return xml.join('\r\n');
}

// Fast XML tag extractor
function parseTag(xmlBlock, tagName) {
  var regex = new RegExp('<' + tagName + '\\b[^>]*>([\\s\\S]*?)<\\/' + tagName + '>', 'i');
  var m = regex.exec(xmlBlock);
  if (!m) return '';
  var val = m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1').trim();
  return val;
}

// Robust Party Name extraction
function extractPartyName(block) {
  var party = parseTag(block, 'PARTYLEDGERNAME') ||
              parseTag(block, 'PARTYNAME') ||
              parseTag(block, 'BASICBUYERNAME');
  if (party) return party;

  var m = /<LEDGERNAME\b[^>]*>([\s\S]*?)<\/LEDGERNAME>/i.exec(block);
  if (m) {
    var raw = m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1').trim();
    if (raw) return raw;
  }
  return '';
}

// Parse all inventory line items from a voucher block
function parseInventoryEntries(block) {
  var items = [];
  var regex = /<(?:ALLINVENTORYENTRIES|INVENTORYENTRIES|ALLINVENTORYALLOCATIONS|INVENTORYALLOCATIONS)\.LIST\b[^>]*>([\s\S]*?)<\/(?:ALLINVENTORYENTRIES|INVENTORYENTRIES|ALLINVENTORYALLOCATIONS|INVENTORYALLOCATIONS)\.LIST>/gi;
  var match;
  while ((match = regex.exec(block)) !== null) {
    var entryBlock = match[1];
    var itemName = parseTag(entryBlock, 'STOCKITEMNAME');
    if (!itemName) continue;

    // Description: collect from BASICUSERDESCRIPTION or DESCRIPTION
    var desc = '';
    var descListRegex = /<BASICUSERDESCRIPTION\b[^>]*>([\s\S]*?)<\/BASICUSERDESCRIPTION>/gi;
    var dMatch;
    var descs = [];
    while ((dMatch = descListRegex.exec(entryBlock)) !== null) {
      var dVal = dMatch[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1').trim();
      if (dVal) descs.push(dVal);
    }
    if (descs.length > 0) {
      desc = descs.join(' ');
    } else {
      desc = parseTag(entryBlock, 'DESCRIPTION') || parseTag(entryBlock, 'USERDESCRIPTION');
    }

    // Billed Qty string e.g. " 10 ROLL" or " 1,700 FT" or " 20 Dozens"
    var rawQty = parseTag(entryBlock, 'BILLEDQTY') || parseTag(entryBlock, 'ACTUALQTY') || parseTag(entryBlock, 'QTY');
    var qtyClean = rawQty.replace(/,/g, '').trim();
    var qtyNum = parseFloat(qtyClean) || 0;

    // Extract unit: text part from qty string, or UNIT tag
    var unit = rawQty.replace(/[0-9.,\s+-]/g, '').trim();
    if (!unit) {
      unit = parseTag(entryBlock, 'UNIT') || parseTag(entryBlock, 'BASEUNITS');
    }

    // Rate e.g. "1615.00/ROLL" or "8.18/FT" or "1615.00"
    var rawRate = parseTag(entryBlock, 'RATE');
    var rateClean = rawRate.replace(/,/g, '').trim();
    var rateNum = parseFloat(rateClean) || 0;
    var perUnit = unit;
    if (rawRate.indexOf('/') !== -1) {
      perUnit = rawRate.split('/')[1].trim();
    }

    // Discount %
    var rawDisc = parseTag(entryBlock, 'DISCOUNT') || parseTag(entryBlock, 'DISCOUNTPERCENT');
    var discNum = parseFloat(rawDisc) || 0;

    // Line amount
    var rawAmt = parseTag(entryBlock, 'AMOUNT');
    var amtNum = Math.abs(parseFloat(String(rawAmt).replace(/,/g, '').trim()) || 0);

    items.push({
      item_name: itemName,
      description: desc,
      quantity: qtyNum,
      unit: unit,
      rate: rateNum,
      per_unit: perUnit,
      discount: discNum,
      amount: amtNum
    });
  }
  return items;
}

// Parse all ledger entries from a voucher block
function parseLedgerEntries(block, partyName) {
  var ledgers = [];
  var regex = /<(?:ALLLEDGERENTRIES|LEDGERENTRIES)\.LIST\b[^>]*>([\s\S]*?)<\/(?:ALLLEDGERENTRIES|LEDGERENTRIES)\.LIST>/gi;
  var match;
  while ((match = regex.exec(block)) !== null) {
    var entryBlock = match[1];
    var lName = parseTag(entryBlock, 'LEDGERNAME');
    if (!lName) continue;
    var rawAmt = parseTag(entryBlock, 'AMOUNT');
    var amt = parseFloat(String(rawAmt).replace(/,/g, '').trim()) || 0;
    var isDeemedPositive = (parseTag(entryBlock, 'ISDEEMEDPOSITIVE') || '').toLowerCase() === 'yes';

    ledgers.push({
      ledger_name: lName,
      amount: amt,
      abs_amount: Math.abs(amt),
      is_deemed_positive: isDeemedPositive
    });
  }

  var partyLedger = null;
  var purchaseLedger = null;
  var taxes = [];
  var normParty = partyName ? partyName.toLowerCase().trim() : '';

  for (var i = 0; i < ledgers.length; i++) {
    var l = ledgers[i];
    var nameLower = l.ledger_name.toLowerCase().trim();

    if (normParty && nameLower === normParty) {
      partyLedger = l;
      continue;
    }

    var isPurchase = nameLower.indexOf('purchase') !== -1;
    var isSales = nameLower.indexOf('sales') !== -1 || nameLower.indexOf('sale ') !== -1;
    var isRoundOff = nameLower.indexOf('round off') !== -1 || nameLower.indexOf('round-off') !== -1;

    var isTax = nameLower.indexOf('cgst') !== -1 ||
                nameLower.indexOf('sgst') !== -1 ||
                nameLower.indexOf('igst') !== -1 ||
                nameLower.indexOf('tax') !== -1 ||
                nameLower.indexOf('gst') !== -1 ||
                nameLower.indexOf('cess') !== -1 ||
                nameLower.indexOf('tcs') !== -1 ||
                nameLower.indexOf('tds') !== -1 ||
                nameLower.indexOf('freight') !== -1 ||
                nameLower.indexOf('discount') !== -1 ||
                isRoundOff;

    if (isRoundOff) {
      taxes.push({
        ledger_name: l.ledger_name,
        amount: l.amount // preserve sign e.g. -0.28
      });
    } else if (isTax && !isPurchase && !isSales) {
      taxes.push({
        ledger_name: l.ledger_name,
        amount: l.abs_amount
      });
    } else if (isPurchase && !purchaseLedger) {
      purchaseLedger = l.ledger_name;
    } else if (isSales && !purchaseLedger) {
      purchaseLedger = l.ledger_name;
    } else if (!partyLedger && l.abs_amount > 0 && !normParty) {
      partyLedger = l;
    } else {
      taxes.push({
        ledger_name: l.ledger_name,
        amount: l.abs_amount
      });
    }
  }

  return {
    all: ledgers,
    party_ledger: partyLedger,
    purchase_ledger: purchaseLedger,
    taxes: taxes
  };
}

// Calculate total voucher amount accurately
function calculateTotalVoucherAmount(block, partyName, parsedLedgers, items) {
  // 1. Party ledger entry amount
  if (parsedLedgers && parsedLedgers.party_ledger && parsedLedgers.party_ledger.abs_amount > 0) {
    return parsedLedgers.party_ledger.abs_amount;
  }

  // 2. Search for party ledger entry matching partyName
  if (partyName) {
    var escapedParty = partyName.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    var pRegex = new RegExp('<(?:ALLLEDGERENTRIES|LEDGERENTRIES)\\.LIST\\b[^>]*>[\\s\\S]*?<LEDGERNAME>\\s*' + escapedParty + '\\s*<\\/LEDGERNAME>[\\s\\S]*?<\\/(?:ALLLEDGERENTRIES|LEDGERENTRIES)\\.LIST>', 'i');
    var pMatch = pRegex.exec(block);
    if (pMatch) {
      var pAmt = parseTag(pMatch[0], 'AMOUNT');
      var pVal = Math.abs(parseFloat(String(pAmt).replace(/,/g, '')) || 0);
      if (pVal > 0) return pVal;
    }
  }

  // 3. Maximum amount found across any ledger tag in the voucher
  var amtRegex = /<AMOUNT\b[^>]*>([\s\S]*?)<\/AMOUNT>/gi;
  var match;
  var maxAmt = 0;
  while ((match = amtRegex.exec(block)) !== null) {
    var rawVal = match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1').trim();
    var val = Math.abs(parseFloat(String(rawVal).replace(/,/g, '')) || 0);
    if (val > maxAmt) {
      maxAmt = val;
    }
  }

  if (maxAmt > 0) return maxAmt;

  // 4. Sum of items if available
  var itemsSum = 0;
  for (var j = 0; j < items.length; j++) {
    itemsSum += items[j].amount;
  }
  return itemsSum;
}

// Parse all vouchers from Tally XML response
function parseVouchersFromXml(xmlText) {
  var vouchers = [];
  var regex = /<VOUCHER\b([^>]*)>([\s\S]*?)<\/VOUCHER>/gi;
  var match;
  while ((match = regex.exec(xmlText)) !== null) {
    var attr = match[1] || '';
    var block = match[2] || '';

    var vchTypeAttr = '';
    var mAttr = /VCHTYPE=["']([^"']*)["']/i.exec(attr);
    if (mAttr) vchTypeAttr = mAttr[1];

    var typeName = parseTag(block, 'VOUCHERTYPENAME') || vchTypeAttr || parseTag(block, 'VCHTYPE') || 'Unknown';
    var partyName = extractPartyName(block);
    var billNumber = parseTag(block, 'REFERENCE') || parseTag(block, 'VOUCHERNUMBER');
    var alterId = Number(parseTag(block, 'ALTERID')) || 0;
    var guid = parseTag(block, 'GUID');

    // Parse full line items
    var items = parseInventoryEntries(block);

    // Parse ledgers & taxes
    var parsedLedgers = parseLedgerEntries(block, partyName);

    // Calculate total bill amount accurately
    var totalAmount = calculateTotalVoucherAmount(block, partyName, parsedLedgers, items);

    // Subtotal of line items
    var subtotal = 0;
    for (var itIdx = 0; itIdx < items.length; itIdx++) {
      subtotal += items[itIdx].amount;
    }

    // Round off
    var roundOffVal = 0;
    for (var txIdx = 0; txIdx < parsedLedgers.taxes.length; txIdx++) {
      if (parsedLedgers.taxes[txIdx].ledger_name.toLowerCase().indexOf('round') !== -1) {
        roundOffVal = parsedLedgers.taxes[txIdx].amount;
        break;
      }
    }

    vouchers.push({
      guid: guid,
      alterId: alterId,
      vchTypeAttr: vchTypeAttr,
      voucherType: typeName,
      voucherNumber: parseTag(block, 'VOUCHERNUMBER') || billNumber,
      reference: parseTag(block, 'REFERENCE') || billNumber,
      partyLedgerName: partyName,
      partyGstin: parseTag(block, 'PARTYGSTIN') || parseTag(block, 'PARTYADDITIONALGSTIN'),
      amount: totalAmount,
      subtotal: subtotal > 0 ? subtotal : totalAmount,
      roundOff: roundOffVal,
      date: formatTallyDate(parseTag(block, 'DATE')),
      narration: parseTag(block, 'NARRATION'),
      costCentre: parseTag(block, 'COSTCENTRENAME'),
      instrumentNumber: parseTag(block, 'INSTRUMENTNUMBER'),
      purchaseLedger: parsedLedgers.purchase_ledger || parseTag(block, 'PURCHASELEDGER'),
      items: items,
      taxes: parsedLedgers.taxes,
    });
  }
  return vouchers;
}

// Voucher classification
function isPurchaseType(v) {
  var t = (v.voucherType + ' ' + v.vchTypeAttr).toLowerCase();
  return (t.indexOf('purchase') !== -1 ||
          t.indexOf('purc') !== -1 ||
          t.indexOf('inward') !== -1 ||
          t.indexOf('material in') !== -1 ||
          t.indexOf('supplier') !== -1 ||
          t.indexOf('vendor') !== -1) &&
         t.indexOf('sale') === -1;
}

function isSalesType(v) {
  var t = (v.voucherType + ' ' + v.vchTypeAttr).toLowerCase();
  if (isPurchaseType(v)) return false;
  return t.indexOf('sale') !== -1 ||
         t.indexOf('invoice') !== -1 ||
         t.indexOf('billing') !== -1 ||
         t.indexOf('outward') !== -1 ||
         t.indexOf('delivery note') !== -1 ||
         t.indexOf('credit note') !== -1;
}

function isBankType(v) {
  var t = (v.voucherType + ' ' + v.vchTypeAttr).toLowerCase();
  return t.indexOf('payment') !== -1 ||
         t.indexOf('pay') !== -1 ||
         t.indexOf('receipt') !== -1 ||
         t.indexOf('rcpt') !== -1 ||
         t.indexOf('contra') !== -1 ||
         t.indexOf('bank') !== -1;
}

// Query Tally trying multiple methods
function queryTally() {
  var q1 = buildDaybookExport(true);
  return request(config.tallyUrl, { method: 'POST', headers: { 'Content-Type': 'text/xml' } }, q1)
    .then(function (res1) {
      var list1 = parseVouchersFromXml(res1.data || '');
      if (list1.length > 0) return { list: list1, raw: res1.data };

      var q2 = buildDayBookReportExport(true);
      return request(config.tallyUrl, { method: 'POST', headers: { 'Content-Type': 'text/xml' } }, q2)
        .then(function (res2) {
          var list2 = parseVouchersFromXml(res2.data || '');
          if (list2.length > 0) return { list: list2, raw: res2.data };

          var q4 = buildDaybookExport(false);
          return request(config.tallyUrl, { method: 'POST', headers: { 'Content-Type': 'text/xml' } }, q4)
            .then(function (res4) {
              var list4 = parseVouchersFromXml(res4.data || '');
              return { list: list4, raw: res4.data || res1.data };
            });
        });
    });
}

// Master sync cycle
function syncFromTally() {
  var state = loadState();
  var now = new Date().toLocaleTimeString();

  return queryTally().then(function (result) {
    var allVouchers = result.list || [];
    var rawText = result.raw || '';

    // Auto-detect open company name from Tally response
    var mComp = /<CURRENTCOMPANY\b[^>]*>([\s\S]*?)<\/CURRENTCOMPANY>/i.exec(rawText) ||
                /<SVCURRENTCOMPANY\b[^>]*>([\s\S]*?)<\/SVCURRENTCOMPANY>/i.exec(rawText);
    if (mComp && mComp[1]) {
      var dComp = mComp[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1').trim();
      if (dComp) config.companyName = dComp;
    }

    if (allVouchers.length === 0) {
      console.log('[' + now + '] Tally connected on port 9000, but 0 vouchers returned.');
      if (rawText) {
        var cleanSnippet = rawText.replace(/[\r\n\t]+/g, ' ').slice(0, 160);
        console.log('       Tally response: ' + cleanSnippet);
      }
      return;
    }

    var typeSummary = {};
    for (var k = 0; k < allVouchers.length; k++) {
      var tName = allVouchers[k].voucherType || 'Unknown';
      typeSummary[tName] = (typeSummary[tName] || 0) + 1;
    }

    var purchasesToSync = [];
    var salesToSync = [];
    var bankTxnsToSync = [];
    var paymentsToSync = [];

    var highestPurchaseAlterId = state.lastPurchaseAlterId || 0;
    var highestSalesAlterId = state.lastSalesAlterId || 0;
    var highestBankAlterId = state.lastBankAlterId || 0;
    var highestPaymentAlterId = state.lastPaymentAlterId || 0;

    for (var i = 0; i < allVouchers.length; i++) {
      var v = allVouchers[i];

      // 1. Process Purchases
      if (isPurchaseType(v)) {
        if (v.alterId > (state.lastPurchaseAlterId || 0)) {
          if (v.alterId > highestPurchaseAlterId) highestPurchaseAlterId = v.alterId;

          var pBillNum = v.reference || v.voucherNumber || ('PUR-' + v.alterId);
          var vName = v.partyLedgerName;
          if (pBillNum && vName && v.amount > 0) {
            purchasesToSync.push({
              tally_guid: v.guid,
              alter_id: v.alterId,
              voucher_type: v.voucherType,
              bill_number: pBillNum,
              bill_date: v.date,
              vendor_name: vName,
              vendor_gstin: v.partyGstin || null,
              bill_amount: v.amount,
              subtotal: v.subtotal,
              round_off: v.roundOff,
              purchase_ledger: v.purchaseLedger || null,
              narration: v.narration || '',
              cost_centre: v.costCentre || '',
              company_name: config.companyName,
              items: v.items,
              tax_breakdown: v.taxes,
            });
          }
        }
      }

      // 2. Process Sales
      if (isSalesType(v)) {
        if (v.alterId > (state.lastSalesAlterId || 0)) {
          if (v.alterId > highestSalesAlterId) highestSalesAlterId = v.alterId;

          var sBillNum = v.reference || v.voucherNumber || ('INV-' + v.alterId);
          var cName = v.partyLedgerName;
          if (sBillNum && cName && v.amount > 0) {
            var gstAmt = 0;
            for (var tIdx = 0; tIdx < v.taxes.length; tIdx++) {
              gstAmt += Math.abs(v.taxes[tIdx].amount || 0);
            }
            salesToSync.push({
              tally_guid: v.guid,
              alter_id: v.alterId,
              voucher_type: v.voucherType,
              bill_number: sBillNum,
              bill_date: v.date,
              customer_name: cName,
              customer_gstin: v.partyGstin || null,
              total_amount: v.amount,
              amount: v.subtotal > 0 ? v.subtotal : (v.amount - gstAmt),
              gst_amount: gstAmt,
              round_off: v.roundOff,
              narration: v.narration || '',
              company_name: config.companyName,
              items: v.items,
              tax_breakdown: v.taxes,
            });
          }
        }
      }

      // 3. Process Bank / Cash Transactions (Payments, Receipts, Contras)
      if (isBankType(v)) {
        if (v.alterId > (state.lastBankAlterId || 0)) {
          if (v.alterId > highestBankAlterId) highestBankAlterId = v.alterId;

          if (v.amount > 0 && v.date) {
            bankTxnsToSync.push({
              tally_guid: v.guid,
              alter_id: v.alterId,
              voucher_type: v.voucherType,
              voucher_number: v.voucherNumber,
              ref_no: v.reference || v.voucherNumber,
              date: v.date,
              amount: v.amount,
              party_name: v.partyLedgerName,
              instrument_number: v.instrumentNumber,
              narration: v.narration || '',
              company_name: config.companyName,
            });
          }
        }

        // Also check vendor bill reconciliation for payments
        var isPay = (v.voucherType + ' ' + v.vchTypeAttr).toLowerCase().indexOf('payment') !== -1;
        if (isPay && v.alterId > (state.lastPaymentAlterId || 0)) {
          if (v.alterId > highestPaymentAlterId) highestPaymentAlterId = v.alterId;
          var pParty = v.partyLedgerName;
          if (pParty && v.amount > 0) {
            paymentsToSync.push({
              tally_guid: v.guid,
              alter_id: v.alterId,
              payment_date: v.date,
              vendor_name: pParty,
              amount: v.amount,
              bill_ref: v.reference || '',
              utr_ref: v.instrumentNumber || null,
              narration: v.narration || '',
              company_name: config.companyName,
            });
          }
        }
      }
    }

    // Diagnostic console output
    console.log('[' + now + '] Tally connected (' + config.companyName + '): ' + allVouchers.length + ' total voucher(s) found.');
    var summaryParts = [];
    for (var sType in typeSummary) {
      if (typeSummary.hasOwnProperty(sType)) {
        summaryParts.push(sType + ': ' + typeSummary[sType]);
      }
    }
    console.log('       Breakdown: ' + summaryParts.join(', '));

    // Display the latest voucher found in Tally
    var latest = allVouchers[allVouchers.length - 1];
    var latestItemsCount = (latest.items && latest.items.length) ? (' | ' + latest.items.length + ' item(s)') : '';
    console.log('       Latest voucher in Tally: [' + latest.voucherType + ']' +
                ' No: ' + (latest.reference || latest.voucherNumber || 'N/A') +
                ' | Party: ' + (latest.partyLedgerName || 'N/A') +
                ' | Date: ' + (latest.date || 'N/A') +
                ' | Rs. ' + latest.amount +
                latestItemsCount +
                ' | AlterID: ' + latest.alterId);

    // Sequence stream pushes
    var chain = Promise.resolve();

    // Push Purchases
    if (purchasesToSync.length > 0) {
      var totalItems = 0;
      for (var pi = 0; pi < purchasesToSync.length; pi++) {
        totalItems += (purchasesToSync[pi].items ? purchasesToSync[pi].items.length : 0);
      }
      console.log('[Purchases] Pushing ' + purchasesToSync.length + ' purchase bill(s) to ERP with ' + totalItems + ' line item(s)...');
      var pBody = JSON.stringify({ vouchers: purchasesToSync, company_name: config.companyName });
      chain = chain.then(function () {
        return request(config.erpBaseUrl + '/vouchers', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(pBody),
            'X-Tally-Token': config.apiToken,
          }
        }, pBody).then(function (erpRes) {
          console.log('[Purchases] ERP Response:', erpRes.data);
          state.lastPurchaseAlterId = highestPurchaseAlterId;
          saveState(state);
        });
      });
    }

    // Push Sales
    if (salesToSync.length > 0) {
      console.log('[Sales] Pushing ' + salesToSync.length + ' sales invoice(s) to ERP...');
      var sBody = JSON.stringify({ vouchers: salesToSync, company_name: config.companyName });
      chain = chain.then(function () {
        return request(config.erpBaseUrl + '/sales', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(sBody),
            'X-Tally-Token': config.apiToken,
          }
        }, sBody).then(function (erpRes) {
          console.log('[Sales] ERP Response:', erpRes.data);
          state.lastSalesAlterId = highestSalesAlterId;
          saveState(state);
        });
      });
    }

    // Push Bank Transactions
    if (bankTxnsToSync.length > 0) {
      console.log('[Bank] Pushing ' + bankTxnsToSync.length + ' bank transaction(s) to ERP...');
      var bBody = JSON.stringify({ transactions: bankTxnsToSync, company_name: config.companyName });
      chain = chain.then(function () {
        return request(config.erpBaseUrl + '/bank', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(bBody),
            'X-Tally-Token': config.apiToken,
          }
        }, bBody).then(function (erpRes) {
          console.log('[Bank] ERP Response:', erpRes.data);
          state.lastBankAlterId = highestBankAlterId;
          saveState(state);
        });
      });
    }

    // Push Vendor Bill Payments (Reconciliation)
    if (paymentsToSync.length > 0) {
      console.log('[Payments] Reconciling ' + paymentsToSync.length + ' payment(s) to bills...');
      var payBody = JSON.stringify({ payments: paymentsToSync, company_name: config.companyName });
      chain = chain.then(function () {
        return request(config.erpBaseUrl + '/payments', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payBody),
            'X-Tally-Token': config.apiToken,
          }
        }, payBody).then(function (erpRes) {
          console.log('[Payments] ERP Response:', erpRes.data);
          state.lastPaymentAlterId = highestPaymentAlterId;
          saveState(state);
        });
      });
    }

    return chain.then(function () {
      if (purchasesToSync.length === 0 && salesToSync.length === 0 && bankTxnsToSync.length === 0 && paymentsToSync.length === 0) {
        var maxId = Math.max(state.lastPurchaseAlterId || 0, state.lastSalesAlterId || 0, state.lastBankAlterId || 0);
        console.log('[' + now + '] Up to date. No new Purchase, Sales, or Bank vouchers to push (Last AlterID: ' + maxId + '). Next check in ' + config.syncIntervalSeconds + 's.');
      }
    });

  }).catch(function (err) {
    if (err.code === 'ECONNREFUSED') {
      console.warn('[' + now + '] Tally not reachable at ' + config.tallyUrl + '. Is Tally open with Port 9000 enabled?');
    } else if (err.statusCode === 401) {
      console.error('[' + now + '] Authentication Error: Invalid X-Tally-Token in config.json.');
    } else {
      console.error('[' + now + '] Sync cycle error:', err.message);
    }
  });
}

// Agent startup Banner
console.log('============================================');
console.log('   SEPL TALLY -> ERP SYNC AGENT STARTED    ');
console.log('============================================');
console.log('Tally URL:    ' + config.tallyUrl);
console.log('ERP Endpoint: ' + config.erpBaseUrl);
console.log('Company:      ' + config.companyName);
console.log('Interval:     ' + config.syncIntervalSeconds + ' seconds');
console.log('Dates:        ' + config.fromDate + ' to ' + config.toDate);
console.log('Streams:      Purchases, Sales, Bank Transactions');
console.log('--------------------------------------------');

// Run initial sync immediately, then on schedule
syncFromTally();
setInterval(syncFromTally, Math.max(30, config.syncIntervalSeconds) * 1000);
