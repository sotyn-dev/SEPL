/**
 * Quick Diagnostic Script for SEPL Tally Sync
 * Run: node test-tally.js
 */

var http = require('http');
var https = require('https');
var url = require('url');

var TALLY_URL = 'http://localhost:9000';
var ERP_URL = 'https://securederp.in/api/tally-sync/vouchers';
var TOKEN = 'sepl_5422b039882d8814d20d1c8eacfd9632';

function request(reqUrl, options, postData) {
  return new Promise(function (resolve, reject) {
    var p = url.parse(reqUrl);
    var isHttps = p.protocol === 'https:';
    var mod = isHttps ? https : http;

    var req = mod.request({
      hostname: p.hostname,
      port: p.port || (isHttps ? 443 : 80),
      path: (p.pathname || '/') + (p.search || ''),
      method: (options && options.method) || 'GET',
      headers: (options && options.headers) || {},
    }, function (res) {
      var body = '';
      res.on('data', function (c) { body += c; });
      res.on('end', function () { resolve({ status: res.statusCode, data: body }); });
    });
    req.on('error', reject);
    req.setTimeout(15000, function () { req.abort(); reject(new Error('Timed out')); });
    if (postData) req.write(postData);
    req.end();
  });
}

console.log('\n--- 1. Testing SEPL ERP Cloud Connection ---');
var testBody = JSON.stringify({ vouchers: [] });
request(ERP_URL, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(testBody),
    'X-Tally-Token': TOKEN
  }
}, testBody).then(function (res) {
  console.log('[OK] Connected to ERP Cloud! Status: ' + res.status);
  console.log('     Response: ' + res.data);
}).catch(function (err) {
  console.log('[FAIL] Could not reach ERP Cloud: ' + err.message);
}).then(function () {
  console.log('\n--- 2. Testing Tally Port 9000 & Exporting Daybook ---');

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
    '        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>',
    '        <SVFROMDATE TYPE="Date">1-Apr-2024</SVFROMDATE>',
    '        <SVTODATE TYPE="Date">31-Dec-2027</SVTODATE>',
    '      </STATICVARIABLES>',
    '    </DESC>',
    '  </BODY>',
    '</ENVELOPE>'
  ].join('\r\n');

  return request(TALLY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml' }
  }, xml);
}).then(function (res) {
  var text = res.data || '';
  var regex = /<VOUCHER\b([^>]*)>([\s\S]*?)<\/VOUCHER>/gi;
  var vouchers = [];
  var match;

  function tag(b, t) {
    var m = new RegExp('<' + t + '[^>]*>([\\s\\S]*?)<\\/' + t + '>', 'i').exec(b);
    return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1').trim() : '';
  }

  while ((match = regex.exec(text)) !== null) {
    var b = match[2];
    vouchers.push({
      type: tag(b, 'VOUCHERTYPENAME') || tag(b, 'VCHTYPE'),
      num: tag(b, 'REFERENCE') || tag(b, 'VOUCHERNUMBER'),
      party: tag(b, 'PARTYLEDGERNAME') || tag(b, 'PARTYNAME') || tag(b, 'BASICBUYERNAME'),
      amt: tag(b, 'AMOUNT'),
      date: tag(b, 'DATE'),
      alterId: tag(b, 'ALTERID')
    });
  }

  console.log('[OK] Successfully received response from Tally on Port 9000!');
  console.log('     Total vouchers found in Tally: ' + vouchers.length);

  if (vouchers.length > 0) {
    console.log('\n--- Vouchers in Tally (Last ' + Math.min(5, vouchers.length) + ') ---');
    var sample = vouchers.slice(-5);
    for (var i = 0; i < sample.length; i++) {
      var v = sample[i];
      console.log('  [' + (i + 1) + '] Type: ' + v.type +
                  ' | No: ' + (v.num || 'N/A') +
                  ' | Party: ' + (v.party || 'N/A') +
                  ' | Date: ' + (v.date || 'N/A') +
                  ' | Amount: ' + (v.amt || '0') +
                  ' | AlterID: ' + v.alterId);
    }
  } else {
    console.log('     Note: 0 vouchers returned.');
    console.log('     Raw snippet: ' + text.replace(/[\r\n\t]+/g, ' ').slice(0, 200));
  }
}).catch(function (err) {
  console.log('[FAIL] Could not query Tally: ' + err.message);
  console.log('       Make sure Tally is open with Port 9000 enabled (F1: Help -> Settings -> Connectivity -> Port 9000).');
});
