// Local Test Data Seeder for SOP-09 (Site Work & Daily Report)
// Feeds realistic sample data for testing all 6 stages (S1 to S6) and RACI delegations locally.
const { getDb } = require('../db/schema');
const db = getDb();

function seedSop09() {
  console.log('Seeding SOP-09 local test data...');

  const today = new Date().toISOString().slice(0, 10);

  // 1. Ensure Key RACI Users Exist
  const usersToEnsure = [
    { name: 'Ruksana', email: 'ruksana@securedengineers.com', role: 'user', department: 'HR' },
    { name: 'Adarsh Kumar', email: 'adarsh@securedengineers.com', role: 'user', department: 'Site Operations' },
    { name: 'Ambuj', email: 'ambuj@securedengineers.com', role: 'admin', department: 'Management' },
    { name: 'Awadhesh Kumar Sharma', email: 'awadhesh@securedengineers.com', role: 'user', department: 'Procurement' },
    { name: 'Lovely Sharma', email: 'lovely@securedengineers.com', role: 'user', department: 'Sales' },
    { name: 'Ajmer', email: 'ajmer@securedengineers.com', role: 'user', department: 'Plant & Machinery' },
    { name: 'Pooja Kaplesh', email: 'info@securedengineers.com', role: 'admin', department: 'Accounts' },
    { name: 'Vikas Singh (Site Engineer)', email: 'vikas.site@securedengineers.com', role: 'user', department: 'Site Operations' },
  ];

  for (const u of usersToEnsure) {
    const ex = db.prepare('SELECT id FROM users WHERE LOWER(name)=LOWER(?) OR LOWER(email)=LOWER(?)').get(u.name, u.email);
    if (!ex) {
      db.prepare(`
        INSERT INTO users (name, email, username, password, role, department, active)
        VALUES (?, ?, ?, ?, ?, ?, 1)
      `).run(u.name, u.email, u.email.split('@')[0], 'hash', u.role, u.department);
      console.log(`✓ Created user: ${u.name} (${u.department})`);
    }
  }

  // Look up user IDs
  const ruksanaId = db.prepare('SELECT id FROM users WHERE LOWER(name) LIKE ?').get('%ruksana%')?.id;
  const adarshId = db.prepare('SELECT id FROM users WHERE LOWER(name) LIKE ?').get('%adarsh%')?.id;
  const ambujId = db.prepare('SELECT id FROM users WHERE LOWER(name) LIKE ?').get('%ambuj%')?.id;
  const vikasId = db.prepare('SELECT id FROM users WHERE LOWER(name) LIKE ?').get('%vikas%')?.id || adarshId;

  // 2. Ensure Sample Sites Exist
  const sampleSites = [
    { name: 'Consern Pharma Site', client_name: 'Consern Pharma Pvt Ltd', eng_id: vikasId },
    { name: 'Apex Solar Power Park', client_name: 'Apex Green Energy', eng_id: vikasId },
    { name: 'Metro Plaza Towers', client_name: 'Metro Realcon', eng_id: vikasId },
    { name: 'Hero Logistics Hub Phase 2', client_name: 'Hero Logistics Ltd', eng_id: vikasId },
  ];

  const siteIds = [];
  for (const s of sampleSites) {
    let row = db.prepare('SELECT id FROM sites WHERE name=?').get(s.name);
    if (!row) {
      const ins = db.prepare(`
        INSERT INTO sites (name, client_name, site_engineer_id, status)
        VALUES (?, ?, ?, 'active')
      `).run(s.name, s.client_name, s.eng_id);
      siteIds.push(ins.lastInsertRowid);
      console.log(`✓ Created site: ${s.name}`);
    } else {
      siteIds.push(row.id);
    }
  }

  const [site1, site2, site3, site4] = siteIds;

  // 3. S1: Ready-Checklist Master (7 Pillars)
  // Site 1: All 7 pillars OK -> Ready
  db.prepare(`
    INSERT INTO site_ready_checklists
      (site_id, work_area, checklist_date, drawing_ok, material_ok, space_ok, men_ok, tools_ok, safety_ok, client_ok, is_ready, remarks, checked_by)
    VALUES (?, 'Substation Area', ?, 1, 1, 1, 1, 1, 1, 1, 1, 'All 7 Pillars Verified: Work cleared to commence', ?)
    ON CONFLICT(site_id, work_area, checklist_date) DO UPDATE SET
      drawing_ok=1, material_ok=1, space_ok=1, men_ok=1, tools_ok=1, safety_ok=1, client_ok=1, is_ready=1
  `).run(site1, today, vikasId);

  // Site 2: Half-ready (Drawing and Tools missing) -> Half-Ready Blocked
  db.prepare(`
    INSERT INTO site_ready_checklists
      (site_id, work_area, checklist_date, drawing_ok, material_ok, space_ok, men_ok, tools_ok, safety_ok, client_ok, is_ready, remarks, checked_by)
    VALUES (?, 'Inverter Room 2', ?, 0, 1, 1, 1, 0, 1, 1, 0, 'Half-ready: Pending GFC revision drawing and scaffolding tools', ?)
    ON CONFLICT(site_id, work_area, checklist_date) DO UPDATE SET
      drawing_ok=0, material_ok=1, space_ok=1, men_ok=1, tools_ok=0, safety_ok=1, client_ok=1, is_ready=0
  `).run(site2, today, vikasId);

  // Site 3: Half-ready (Client space access missing) -> Half-Ready Blocked
  db.prepare(`
    INSERT INTO site_ready_checklists
      (site_id, work_area, checklist_date, drawing_ok, material_ok, space_ok, men_ok, tools_ok, safety_ok, client_ok, is_ready, remarks, checked_by)
    VALUES (?, 'Tower A Roof', ?, 1, 1, 0, 1, 1, 1, 0, 0, 'Client clearance not provided for roof access', ?)
    ON CONFLICT(site_id, work_area, checklist_date) DO UPDATE SET
      drawing_ok=1, material_ok=1, space_ok=0, men_ok=1, tools_ok=1, safety_ok=1, client_ok=0, is_ready=0
  `).run(site3, today, vikasId);

  console.log('✓ Seeded S1 Ready-Checklists (1 Ready, 2 Half-Ready blocked)');

  // 4. S2: Mobile Daily Reports & Photo Proof
  // Site 1: DPR with 3 photos proof
  const dpr1 = db.prepare('SELECT id FROM dpr WHERE site_id=? AND report_date=?').get(site1, today);
  if (!dpr1) {
    db.prepare(`
      INSERT INTO dpr (site_id, report_date, submitted_by, overall_status, contractor_manpower, grand_total_a, grand_total_b, profit_loss, site_photos, remarks)
      VALUES (?, ?, ?, 'on_track', 18, 185000, 142000, 43000, ?, 'Cable laying in underground trench completed')
    `).run(site1, today, vikasId, JSON.stringify(['/uploads/proof-trench-1.jpg', '/uploads/proof-cable-2.jpg', '/uploads/proof-safety-3.jpg']));
  } else {
    db.prepare(`
      UPDATE dpr SET grand_total_a=185000, grand_total_b=142000, profit_loss=43000, contractor_manpower=18,
                     site_photos=? WHERE id=?
    `).run(JSON.stringify(['/uploads/proof-trench-1.jpg', '/uploads/proof-cable-2.jpg', '/uploads/proof-safety-3.jpg']), dpr1.id);
  }

  // Site 2: DPR with NO photos -> triggers "Missing Photo Proof" rule
  const dpr2 = db.prepare('SELECT id FROM dpr WHERE site_id=? AND report_date=?').get(site2, today);
  let dpr2Id = dpr2?.id;
  if (!dpr2) {
    const ins2 = db.prepare(`
      INSERT INTO dpr (site_id, report_date, submitted_by, overall_status, contractor_manpower, grand_total_a, grand_total_b, profit_loss, site_photos, hindrances, hindrance_category, remarks)
      VALUES (?, ?, ?, 'delayed', 4, 38000, 42000, -4000, NULL, 'Shortage of 6 electricians on site', 'Manpower', 'Civil work slowed down')
    `).run(site2, today, vikasId);
    dpr2Id = ins2.lastInsertRowid;
  } else {
    db.prepare(`
      UPDATE dpr SET grand_total_a=38000, grand_total_b=42000, profit_loss=-4000, contractor_manpower=4,
                     site_photos=NULL, hindrances='Shortage of 6 electricians on site', hindrance_category='Manpower' WHERE id=?
    `).run(dpr2.id);
  }

  // Site 3: DPR with Critical Loss -> triggers RED Escalation
  const dpr3 = db.prepare('SELECT id FROM dpr WHERE site_id=? AND report_date=?').get(site3, today);
  let dpr3Id = dpr3?.id;
  if (!dpr3) {
    const ins3 = db.prepare(`
      INSERT INTO dpr (site_id, report_date, submitted_by, overall_status, contractor_manpower, grand_total_a, grand_total_b, profit_loss, site_photos, hindrances, hindrance_category, remarks)
      VALUES (?, ?, ?, 'blocked', 2, 22000, 48000, -26000, ?, 'Crane breakdown and delivery delayed from supplier', 'Machine', 'Severe site stoppage')
    `).run(site3, today, vikasId, JSON.stringify(['/uploads/crane-breakdown.jpg']));
    dpr3Id = ins3.lastInsertRowid;
  } else {
    db.prepare(`
      UPDATE dpr SET grand_total_a=22000, grand_total_b=48000, profit_loss=-26000, contractor_manpower=2,
                     hindrances='Crane breakdown and delivery delayed from supplier', hindrance_category='Machine' WHERE id=?
    `).run(dpr3.id);
  }

  console.log('✓ Seeded S2 Daily Reports (with photos proof and missing photo test)');

  // 5. S3: Problem to Task (One Name, One Date)
  // Auto-assigned Task for Ruksana (HR):
  const existingHrTask = db.prepare("SELECT id FROM pms_tasks WHERE title LIKE '%[SOP-09.3 · MANPOWER]%'").get();
  if (!existingHrTask) {
    db.prepare(`
      INSERT INTO pms_tasks (title, description, assigned_by, assigned_to, due_date, status, flow_number, project_name_snapshot)
      VALUES ('[SOP-09.3 · MANPOWER] Deploy 6 electricians to Apex Solar Park', 'Site: Apex Solar Power Park | Report Date: today\nShortage of 6 electricians on site.\nAuto-assigned via SOP-09.3 to HR Incharge (Ruksana)', ?, ?, ?, 'pending', '9.3', 'Apex Solar Power Park')
    `).run(vikasId, ruksanaId, today);
    console.log('✓ Seeded S3 Task assigned to Ruksana (HR)');
  }

  // 6. S4: Buffer Update (Weekly Plans)
  function mondayOf(dStr) {
    const d = new Date(dStr + 'T00:00:00Z');
    const day = d.getUTCDay();
    const diff = (day === 0 ? -6 : 1) - day;
    d.setUTCDate(d.getUTCDate() + diff);
    return d.toISOString().slice(0, 10);
  }
  const wkStart = mondayOf(today);

  // Site 1 Plan: Healthy buffer (>100%)
  db.prepare(`
    INSERT INTO weekly_plans (site_id, week_start, status, submitted_by, approved_by)
    VALUES (?, ?, 'approved', ?, ?)
    ON CONFLICT(site_id, week_start) DO UPDATE SET status='approved'
  `).run(site1, wkStart, vikasId, adarshId);

  // Site 2 Plan: Watch buffer (80%)
  db.prepare(`
    INSERT INTO weekly_plans (site_id, week_start, status, submitted_by, approved_by)
    VALUES (?, ?, 'approved', ?, ?)
    ON CONFLICT(site_id, week_start) DO UPDATE SET status='approved'
  `).run(site2, wkStart, vikasId, adarshId);

  // Site 3 Plan: Critical buffer (<50%)
  db.prepare(`
    INSERT INTO weekly_plans (site_id, week_start, status, submitted_by, approved_by)
    VALUES (?, ?, 'approved', ?, ?)
    ON CONFLICT(site_id, week_start) DO UPDATE SET status='approved'
  `).run(site3, wkStart, vikasId, adarshId);

  console.log('✓ Seeded S4 Weekly Plans & Buffer metrics');

  // 7. S6: Closing Checklist with Photo Verification
  db.prepare(`
    INSERT INTO site_closing_checklists
      (site_id, work_area, closing_date, quality_ok, safety_ok, photos_json, remarks, closed_by)
    VALUES (?, 'Substation Transformer Bay', ?, 1, 1, ?, 'Final QA inspection passed, site cleaned and handed over', ?)
    ON CONFLICT(site_id, work_area, closing_date) DO UPDATE SET quality_ok=1, safety_ok=1
  `).run(site1, today, JSON.stringify(['/uploads/handover-clean.jpg', '/uploads/handover-safety.jpg']), vikasId);

  console.log('✓ Seeded S6 Closing Checklist with photos verification');

  console.log('\n======================================================');
  console.log('✅ SOP-09 LOCAL TEST DATA FEED COMPLETED SUCCESSFULLY!');
  console.log('======================================================');
  console.log('Now open your browser and navigate to:');
  console.log('👉 http://localhost:5173/site-work-board');
  console.log('Or click "Site Work Board (SOP-09)" under Projects in the left sidebar.');
  console.log('======================================================\n');
}

seedSop09();
