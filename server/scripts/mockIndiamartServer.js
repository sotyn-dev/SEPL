// Mock IndiaMART CRM v2 Pull API server — local testing only.
//
// Mimics https://mapi.indiamart.com/wservce/crm/crmListing/v2/ so the funnel
// poller can run a complete end-to-end flow on localhost without a real key.
//
// Usage:
//   node server/scripts/mockIndiamartServer.js        (default port 5099)
//   PORT=5098 node server/scripts/mockIndiamartServer.js
//
// Then in .env set:
//   INDIAMART_MOCK_URL=http://localhost:5099
//   INDIAMART_CRM_KEY=mock-key-for-testing
// The poller will hit this server instead of mapi.indiamart.com.
//
// Each call returns a random slice of the MOCK_LEADS pool (simulates real
// rolling-window results). Re-run the poller within the same window → dedup
// kicks in (INSERT OR IGNORE) as expected.

const http = require('http');
const url = require('url');

const PORT = Number(process.env.PORT) || 5099;

// ─── Mock lead pool (8 leads, 5 states) ──────────────────────────────
// Field names mirror IndiaMART v2 API exactly (UPPER_CASE). See:
//   CRM_V2_API_Response.jpg / crm_v2_output_parameters.jpg
const MOCK_LEADS = [
  {
    UNIQUE_QUERY_ID: 'MOCK-PB-001',
    QUERY_TYPE: 'BUY',
    QUERY_TIME: '11 Jun 2026 09:15:33',
    SENDER_NAME: 'Harpreet Singh',
    SENDER_MOBILE: '9876543210',
    SENDER_MOBILE_ALT: '',
    SENDER_EMAIL: 'harpreet.singh@hsengg.in',
    SENDER_EMAIL_ALT: '',
    SENDER_COMPANY: 'HS Engineering Works',
    SENDER_ADDRESS: 'Phase 8, Industrial Area',
    SENDER_CITY: 'Ludhiana',
    SENDER_STATE: 'Punjab',
    SENDER_PIN: '141010',
    SENDER_COUNTRY_ISO: 'IN',
    QUERY_PRODUCT_NAME: 'MS ERW Black Pipe',
    QUERY_MCAT_NAME: 'Pipes and Tubes',
    QUERY_MESSAGE: 'Need 100 pcs of 2 inch MS ERW black pipe, 6 meter length, IS:1239 standard. Please share your best price with delivery to Ludhiana.',
    CALL_DURATION: '0',
    RECEIVER_MOBILE: '9988776655',
  },
  {
    UNIQUE_QUERY_ID: 'MOCK-HR-002',
    QUERY_TYPE: 'BUY',
    QUERY_TIME: '11 Jun 2026 10:02:07',
    SENDER_NAME: 'Ramesh Kumar',
    SENDER_MOBILE: '9812345678',
    SENDER_MOBILE_ALT: '',
    SENDER_EMAIL: 'ramesh@gconstruction.com',
    SENDER_EMAIL_ALT: '',
    SENDER_COMPANY: 'Gurugram Construction Co.',
    SENDER_ADDRESS: 'Sector 57',
    SENDER_CITY: 'Gurugram',
    SENDER_STATE: 'Haryana',
    SENDER_PIN: '122011',
    SENDER_COUNTRY_ISO: 'IN',
    QUERY_PRODUCT_NAME: 'GI Pipe 1 inch',
    QUERY_MCAT_NAME: 'GI Pipes',
    QUERY_MESSAGE: 'Require 50 pieces of 1 inch GI medium class pipe for a residential project. Urgently needed. What is your rate per piece delivered to Gurugram?',
    CALL_DURATION: '0',
    RECEIVER_MOBILE: '9988776655',
  },
  {
    UNIQUE_QUERY_ID: 'MOCK-MH-003',
    QUERY_TYPE: 'BUY',
    QUERY_TIME: '11 Jun 2026 11:30:45',
    SENDER_NAME: 'Suresh Patil',
    SENDER_MOBILE: '9823456789',
    SENDER_MOBILE_ALT: '9823456780',
    SENDER_EMAIL: 'suresh.patil@mhinfra.co.in',
    SENDER_EMAIL_ALT: '',
    SENDER_COMPANY: 'MH Infrastructure Pvt Ltd',
    SENDER_ADDRESS: 'Andheri East',
    SENDER_CITY: 'Mumbai',
    SENDER_STATE: 'Maharashtra',
    SENDER_PIN: '400069',
    SENDER_COUNTRY_ISO: 'IN',
    QUERY_PRODUCT_NAME: 'MS Flanges PN16',
    QUERY_MCAT_NAME: 'Flanges and Fittings',
    QUERY_MESSAGE: 'Looking for MS slip-on flanges PN16, sizes 50mm to 150mm. Quantity around 200 pieces. Need ISI marked material. Please quote with GST and delivery charges to Mumbai.',
    CALL_DURATION: '0',
    RECEIVER_MOBILE: '9988776655',
  },
  {
    UNIQUE_QUERY_ID: 'MOCK-TN-004',
    QUERY_TYPE: 'BUY',
    QUERY_TIME: '11 Jun 2026 12:15:22',
    SENDER_NAME: 'Karthik Sundaram',
    SENDER_MOBILE: '9841234567',
    SENDER_MOBILE_ALT: '',
    SENDER_EMAIL: 'karthik.sundaram@tnindustries.com',
    SENDER_EMAIL_ALT: '',
    SENDER_COMPANY: 'TN Industrial Supplies',
    SENDER_ADDRESS: 'SIDCO Industrial Estate, Ambattur',
    SENDER_CITY: 'Chennai',
    SENDER_STATE: 'Tamil Nadu',
    SENDER_PIN: '600098',
    SENDER_COUNTRY_ISO: 'IN',
    QUERY_PRODUCT_NAME: 'Ball Valve SS 316',
    QUERY_MCAT_NAME: 'Industrial Valves',
    QUERY_MESSAGE: 'We need stainless steel ball valves SS316, 2 piece body, 1/2 inch to 2 inch sizes, threaded ends. Quantity 50 pcs each size. Urgent requirement for refinery project.',
    CALL_DURATION: '120',
    RECEIVER_MOBILE: '9988776655',
  },
  {
    UNIQUE_QUERY_ID: 'MOCK-HP-005',
    QUERY_TYPE: 'BUY',
    QUERY_TIME: '11 Jun 2026 13:45:11',
    SENDER_NAME: 'Vikram Thakur',
    SENDER_MOBILE: '9816543210',
    SENDER_MOBILE_ALT: '',
    SENDER_EMAIL: 'vikram.thakur@hpprojects.in',
    SENDER_EMAIL_ALT: '',
    SENDER_COMPANY: 'HP Hill Projects',
    SENDER_ADDRESS: 'Baddi Industrial Area',
    SENDER_CITY: 'Baddi',
    SENDER_STATE: 'Himachal Pradesh',
    SENDER_PIN: '173205',
    SENDER_COUNTRY_ISO: 'IN',
    QUERY_PRODUCT_NAME: 'HDPE Pipe 110mm',
    QUERY_MCAT_NAME: 'HDPE Pipes',
    QUERY_MESSAGE: 'Need HDPE pipe 110mm OD, SDR11, PE100, 6 meter length for water supply project. Approximately 500 meters total. Delivery to Baddi, HP. Please share price list.',
    CALL_DURATION: '0',
    RECEIVER_MOBILE: '9988776655',
  },
  {
    UNIQUE_QUERY_ID: 'MOCK-PB-006',
    QUERY_TYPE: 'BUY',
    QUERY_TIME: '11 Jun 2026 14:20:05',
    SENDER_NAME: 'Jaswant Singh',
    SENDER_MOBILE: '9872345678',
    SENDER_MOBILE_ALT: '',
    SENDER_EMAIL: 'jaswant@amarsteels.com',
    SENDER_EMAIL_ALT: '',
    SENDER_COMPANY: 'Amar Steels',
    SENDER_ADDRESS: 'Focal Point',
    SENDER_CITY: 'Amritsar',
    SENDER_STATE: 'Punjab',
    SENDER_PIN: '143001',
    SENDER_COUNTRY_ISO: 'IN',
    QUERY_PRODUCT_NAME: 'MS Square Hollow Section',
    QUERY_MCAT_NAME: 'Structural Steel',
    QUERY_MESSAGE: 'Require MS square hollow section 50x50x3mm, 40x40x3mm, 6m lengths. Need about 5 MT total for a warehouse fabrication job. What is your current rate per kg? Delivery required.',
    CALL_DURATION: '0',
    RECEIVER_MOBILE: '9988776655',
  },
  {
    UNIQUE_QUERY_ID: 'MOCK-MH-007',
    QUERY_TYPE: 'BUY',
    QUERY_TIME: '11 Jun 2026 15:10:33',
    SENDER_NAME: 'Priya Mehta',
    SENDER_MOBILE: '9765432109',
    SENDER_MOBILE_ALT: '9765432100',
    SENDER_EMAIL: 'priya.mehta@pmengg.in',
    SENDER_EMAIL_ALT: '',
    SENDER_COMPANY: 'PM Engineering Solutions',
    SENDER_ADDRESS: 'Pimpri-Chinchwad MIDC',
    SENDER_CITY: 'Pune',
    SENDER_STATE: 'Maharashtra',
    SENDER_PIN: '411019',
    SENDER_COUNTRY_ISO: 'IN',
    QUERY_PRODUCT_NAME: 'Gate Valve CI',
    QUERY_MCAT_NAME: 'Industrial Valves',
    QUERY_MESSAGE: 'Looking for CI gate valves, 3 inch and 4 inch, PN10 rating, flanged end. Need 10 pcs of each for a water treatment plant. Should have IS:778 certification.',
    CALL_DURATION: '0',
    RECEIVER_MOBILE: '9988776655',
  },
  {
    UNIQUE_QUERY_ID: 'MOCK-HR-008',
    QUERY_TYPE: 'BUY',
    QUERY_TIME: '11 Jun 2026 16:05:58',
    SENDER_NAME: 'Deepak Sharma',
    SENDER_MOBILE: '9817654321',
    SENDER_MOBILE_ALT: '',
    SENDER_EMAIL: 'deepak.sharma@faridfab.com',
    SENDER_EMAIL_ALT: '',
    SENDER_COMPANY: 'Farid Fabricators',
    SENDER_ADDRESS: 'NIT Industrial Area',
    SENDER_CITY: 'Faridabad',
    SENDER_STATE: 'Haryana',
    SENDER_PIN: '121001',
    SENDER_COUNTRY_ISO: 'IN',
    QUERY_PRODUCT_NAME: 'MS Pipe Fittings Elbow Tee',
    QUERY_MCAT_NAME: 'Pipe Fittings',
    QUERY_MESSAGE: 'We need MS butt weld fittings — 90 degree elbows and equal tees, sizes 2 inch to 6 inch, SCH40. Approx 30 pcs each size each type. Monthly requirement. Are you a manufacturer or trader?',
    CALL_DURATION: '45',
    RECEIVER_MOBILE: '9988776655',
  },
  {
    UNIQUE_QUERY_ID: 'MOCK-TN-009',
    QUERY_TYPE: 'CALL',
    QUERY_TIME: '11 Jun 2026 16:50:12',
    SENDER_NAME: 'Murugan K',
    SENDER_MOBILE: '9894567890',
    SENDER_MOBILE_ALT: '',
    SENDER_EMAIL: '',
    SENDER_EMAIL_ALT: '',
    SENDER_COMPANY: 'Coimbatore Process Industries',
    SENDER_ADDRESS: 'SIDCO, Kurichi',
    SENDER_CITY: 'Coimbatore',
    SENDER_STATE: 'Tamil Nadu',
    SENDER_PIN: '641021',
    SENDER_COUNTRY_ISO: 'IN',
    QUERY_PRODUCT_NAME: 'Pressure Gauge SS',
    QUERY_MCAT_NAME: 'Pressure Gauges',
    QUERY_MESSAGE: 'Want SS Bourdon tube pressure gauges, 0-10 bar, 100mm dial, glycerin filled, for chemical plant. Qty 25 pcs. Need calibration certificate. Is Wika / Badotherm available?',
    CALL_DURATION: '85',
    RECEIVER_MOBILE: '9988776655',
  },
  {
    UNIQUE_QUERY_ID: 'MOCK-HP-010',
    QUERY_TYPE: 'BUY',
    QUERY_TIME: '11 Jun 2026 17:25:44',
    SENDER_NAME: 'Atul Verma',
    SENDER_MOBILE: '9805678901',
    SENDER_MOBILE_ALT: '',
    SENDER_EMAIL: 'atul.verma@shimlacontracts.com',
    SENDER_EMAIL_ALT: '',
    SENDER_COMPANY: 'Shimla Contracts & Supplies',
    SENDER_ADDRESS: 'Cart Road',
    SENDER_CITY: 'Shimla',
    SENDER_STATE: 'Himachal Pradesh',
    SENDER_PIN: '171001',
    SENDER_COUNTRY_ISO: 'IN',
    QUERY_PRODUCT_NAME: 'GI Pipe Fitting Elbow Socket',
    QUERY_MCAT_NAME: 'GI Pipe Fittings',
    QUERY_MESSAGE: 'Need GI malleable iron fittings — 90 degree elbows, tees, sockets, reducers, 1/2 inch to 2 inch sizes. Mixed lot of around 500 pieces for a housing project. Please share catalogue with prices.',
    CALL_DURATION: '0',
    RECEIVER_MOBILE: '9988776655',
  },
];

// ─── Request handler ──────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);

  // The real API path: /wservce/crm/crmListing/v2/
  if (!parsed.pathname.includes('crmListing')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ CODE: 404, MESSAGE: 'Not found on mock server' }));
    return;
  }

  const key = parsed.query.glusr_crm_key || '';
  const startTime = parsed.query.start_time || '';
  const endTime = parsed.query.end_time || '';

  console.log(`[mock-indiamart] GET crmListing  key=${key ? key.slice(0, 8) + '…' : '(none)'}  window: ${startTime} → ${endTime}`);

  // Simulate no-key rejection like real API (optional — useful to test that path too).
  // Uncomment the block below to test the 401 handling:
  // if (!key || key === 'bad-key') {
  //   res.writeHead(200, { 'Content-Type': 'application/json' });
  //   res.end(JSON.stringify({ CODE: 401, MESSAGE: 'Invalid credentials' }));
  //   return;
  // }

  // Return a random 4-7 lead slice so repeated calls behave like a real window
  // (might overlap with previous ones → dedup fires naturally).
  const shuffled = [...MOCK_LEADS].sort(() => Math.random() - 0.5);
  const count = 4 + Math.floor(Math.random() * 4); // 4–7 leads
  const response = shuffled.slice(0, count);

  // Wrap in the real API envelope: { CODE: 200, RESPONSE: [...] }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ CODE: 200, MESSAGE: 'Data found.', RESPONSE: response }));
});

server.listen(PORT, () => {
  console.log(`[mock-indiamart] listening on http://localhost:${PORT}`);
  console.log('[mock-indiamart] set INDIAMART_MOCK_URL=http://localhost:' + PORT + ' in your .env');
  console.log('[mock-indiamart] set INDIAMART_CRM_KEY=mock-key-for-testing');
  console.log('[mock-indiamart] pool: ' + MOCK_LEADS.length + ' leads (Punjab, Haryana, Maharashtra, Tamil Nadu, Himachal Pradesh)');
});
