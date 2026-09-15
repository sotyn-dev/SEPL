// One-time seed: mam's "final flow charts . aug 2026" Excel → System Flow
// (mam 2026-09-01: "Please help me to fill this data into here in erp").
//
// 18 SOP charts (SOP-01…SOP-18), 108 steps. Mapping:
//   chart  → System (system_name = "SOP-xx · <chart name>") under a Process
//   S#     → one sysflow_flows row, chained by depends_on (S1←S2←…)
//   SOP ref→ step-master entry (created if missing, so the dropdown grows)
//   who    → responsible (fuzzy-matched to users; chart owner = developer)
//   remarks carry What/When/How + whether the step is an ERP build or a
//   person step ("YES — ERP (manual for now)" ⇒ priority high).
//
// Runs from runSystemFlowMigrations at boot, guarded by an app_settings key
// so it inserts EXACTLY once per database (safe on every pm2 restart).
// Dates: the sheet has SLAs, not build dates — start = today, target
// staggered (+7d then +2d per step) as a working plan mam can edit.
const { nextSequence } = require('../db/nextSequence');
const { istToday } = require('../lib/istDate');

const GUARD_KEY = 'sysflow_sop_seed_2026_09';

// SOP → process bucket (matches the seeded process master)
const SOP_PROCESS = {
  'SOP-01': 'SALES', 'SOP-02': 'SALES', 'SOP-03': 'SALES',
  'SOP-04': 'PROJECT', 'SOP-05': 'PURCHASE', 'SOP-06': 'PROJECT',
  'SOP-07': 'PURCHASE', 'SOP-08': 'INVENTORY', 'SOP-09': 'PROJECT',
  'SOP-10': 'INVENTORY', 'SOP-11': 'PROJECT', 'SOP-12': 'PROJECT',
  'SOP-13': 'ACCOUNTS', 'SOP-14': 'PROJECT', 'SOP-15': 'PROJECT',
  'SOP-16': 'ACCOUNTS', 'SOP-17': 'ACCOUNTS', 'SOP-18': 'ACCOUNTS',
};

// Sheet spellings → ERP user names (first LIKE token that matches wins)
const NAME_ALIASES = {
  'awdesh': 'avadesh', 'rajat sir': 'rajat', 'birender': 'birendra',
  'md. asad ali': 'asad', 'md asad': 'asad', 'asad./naveen': 'asad',
  'auto/ajmer': 'ajmer', 'auto/crm': null, 'site eng': null, 'site engineer': null,
  'site supervisour': null, 'as per requirement': null, 'automatic': null,
  'autommatic': null, 'erp': null, 'crm': null, '—': null, '-': null, '': null,
};

function seedSystemFlowSops(db) {
  const done = db.prepare('SELECT value FROM app_settings WHERE key=?').get(GUARD_KEY);
  if (done) return;

  const charts = require('./sop-flow-charts-2026-08.json');
  const admin = db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get();
  if (!admin) return; // pre-seed DB — try again next boot

  const users = db.prepare("SELECT id, name FROM users WHERE COALESCE(active,1)=1 AND COALESCE(archived,0)=0").all();
  const resolveUser = (raw) => {
    let n = String(raw || '').trim().toLowerCase();
    if (n in NAME_ALIASES) n = NAME_ALIASES[n] || '';
    if (!n) return null;
    const exact = users.find(u => u.name.toLowerCase() === n);
    if (exact) return exact.id;
    for (const tok of n.split(/[\s/,.]+/).filter(t => t.length >= 4)) {
      const alias = NAME_ALIASES[tok] || tok;
      const hit = users.find(u => u.name.toLowerCase().includes(alias));
      if (hit) return hit.id;
    }
    return null;
  };

  const procId = {};
  for (const p of db.prepare('SELECT id, name FROM sysflow_processes').all()) procId[p.name] = p.id;
  const stepByName = db.prepare('SELECT id FROM sysflow_step_master WHERE name=?');
  const insStep = db.prepare('INSERT INTO sysflow_step_master (name, created_by) VALUES (?,?)');
  const insFlow = db.prepare(`
    INSERT INTO sysflow_flows (flow_no, process_id, system_name, step_id, seq, depends_on_id,
      responsible_id, developer_id, start_date, target_date, priority, remarks, created_by, updated_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const logAct = db.prepare(`INSERT INTO sysflow_activity (flow_id, user_id, action, new_value)
    VALUES (?,?, 'created', ?)`);
  const flowExists = db.prepare('SELECT 1 FROM sysflow_flows WHERE system_name=? LIMIT 1');

  const today = istToday();
  const plus = (d) => new Date(new Date(today).getTime() + d * 86400000).toISOString().slice(0, 10);

  let made = 0;
  const tx = db.transaction(() => {
    for (const chart of charts) {
      const systemName = `${chart.sop} · ${chart.name}`;
      if (flowExists.get(systemName)) continue; // never duplicate a chart
      const pid = procId[SOP_PROCESS[chart.sop] || 'ADMIN'] || Object.values(procId)[0];
      const devId = resolveUser(chart.owner) || admin.id;
      let prevId = null;
      // Mam 2026-09-01 ("i need 108 steps here"): ALL steps load — both the
      // ERP builds and the person steps — so every chart is complete in the
      // module. remarks lead with [ERP build]/[Person step] to tell them
      // apart; ERP builds carry priority high, person steps medium.
      chart.steps.forEach((s, i) => {
        // Step-master name: the SOP ref is unique + descriptive
        // ("SOP-01.1 · Lead entry format"); fallback "SOP-01 S1".
        const stepName = (s.sop || `${chart.sop} ${s.s}`).slice(0, 120);
        let sm = stepByName.get(stepName);
        if (!sm) { insStep.run(stepName, admin.id); sm = stepByName.get(stepName); }
        const respId = resolveUser(s.person) || devId;
        const remarks = `[${s.erp ? 'ERP build — manual for now' : 'Person step'}] ${s.what}` +
          (s.when ? ` · When: ${s.when}` : '') + (s.how ? ` · How: ${s.how}` : '') +
          (s.designation ? ` · Role: ${s.designation}` : '');
        const flowNo = nextSequence(db, 'sysflow_flows', 'flow_no', 'ERP-FLOW-', { pad: 4 });
        const r = insFlow.run(flowNo, pid, systemName, sm.id, i + 1, prevId,
          respId, devId, today, plus(7 + i * 2), s.erp ? 'high' : 'medium',
          remarks.slice(0, 900), admin.id, admin.id);
        logAct.run(r.lastInsertRowid, admin.id, `${flowNo} · ${stepName} (seeded from Aug-2026 flow charts)`);
        prevId = r.lastInsertRowid;
        made++;
      });
    }
    db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?,?)')
      .run(GUARD_KEY, new Date().toISOString());
  });
  tx();
  if (made) console.log(`[system_flow] SOP flow-chart seed: ${made} steps across ${charts.length} charts`);
}

module.exports = { seedSystemFlowSops };
