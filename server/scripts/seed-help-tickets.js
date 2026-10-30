const { getDb } = require('../db/schema');
const { nextSequence } = require('../db/nextSequence');

function seedTickets() {
  const db = getDb();

  const sampleTickets = [
    // 1. OVERDUE URGENT BUG - Assigned to Admin
    {
      user_id: 3, // Rajat Sharma
      assigned_to: 1, // Admin
      subject: 'Tally Cloud sync failing for Mumbai & Pune branch vouchers',
      description: 'Automatic sync stops at voucher #4290 with error: Gateway connection timeout. Need to re-trigger batch export.',
      category: 'bug',
      priority: 'urgent',
      status: 'open',
      module: 'Tally Integration',
      attachment_link: JSON.stringify(['/uploads/1788600075018-dv1z8x-Screenshot_2026-08-27_132710.png']),
      deadline_date: '2026-10-28', // Overdue
      created_at: '2026-10-27 10:15:00'
    },
    // 2. DUE TODAY HIGH PRIORITY - Assigned to Admin
    {
      user_id: 5, // Rahul Sharma
      assigned_to: 1, // Admin
      subject: 'Solar Module Quotation PDF layout margin glitch on multi-page proposals',
      description: 'Header logo and sign-off table overlap on page 3 when item list exceeds 12 rows. Client proposal pending.',
      category: 'bug',
      priority: 'high',
      status: 'in_progress',
      module: 'Solar Quotations',
      attachment_link: JSON.stringify([
        '/uploads/1790073992896-rcjjk0-Aging_Column_Proof.jpg',
        '/uploads/1790073992937-gv3lek-Site_Readiness___Client_Snag_Proof.jpg'
      ]),
      deadline_date: '2026-10-30', // Due today
      created_at: '2026-10-29 09:30:00'
    },
    // 3. SUBMITTED UNDER REVIEW - Assigned to Rajat / Raised by Admin
    {
      user_id: 1, // Admin
      assigned_to: 3, // Rajat Sharma
      subject: 'CRM Funnel lead capture timestamp showing blank in table view',
      description: 'When filtering by Q3 leads, the captured_at column shows blank cells for imported leads.',
      category: 'bug',
      priority: 'high',
      status: 'submitted',
      module: 'CRM Funnel',
      attachment_link: JSON.stringify(['/uploads/1790073653618-mcj1c1-Screenshot_2026-09-22_142607.jpg']),
      proof_url: JSON.stringify([
        '/uploads/1790073992969-ioab4z-Drawing_Tracker_Proof.jpg',
        '/uploads/1790074163159-ka8p3b-Aging_Column_Proof.jpg'
      ]),
      proof_notes: 'Fixed in crmFunnel.js query to coalesce created_at when captured_at is null. Verified with all 32 active leads.',
      proof_submitted_at: '2026-10-30 14:20:00',
      proof_submitted_by: 3,
      deadline_date: '2026-10-30',
      created_at: '2026-10-28 11:00:00'
    },
    // 4. OPEN MEDIUM - Assigned to Nancy
    {
      user_id: 1, // Admin
      assigned_to: 4, // Nancy
      subject: 'Add department & designation filter to Employee Export CSV',
      description: 'HR manager requested filtering export directly by Site Operations vs Accounts before downloading Excel/CSV.',
      category: 'feature_request',
      priority: 'medium',
      status: 'open',
      module: 'HR & Employees',
      attachment_link: null,
      deadline_date: '2026-11-03',
      created_at: '2026-10-29 16:45:00'
    },
    // 5. IN PROGRESS URGENT - Assigned to Vikas Singh
    {
      user_id: 1, // Admin
      assigned_to: 7, // Vikas Singh
      subject: 'Site biometric sync offline at Chakan Plant site',
      description: 'Device not sending daily in/out punches to server since 8:00 AM. 14 labourers pending manual muster entry.',
      category: 'data_issue',
      priority: 'urgent',
      status: 'in_progress',
      module: 'Site Operations',
      attachment_link: JSON.stringify(['/uploads/1790073992937-gv3lek-Site_Readiness___Client_Snag_Proof.jpg']),
      deadline_date: '2026-10-30',
      created_at: '2026-10-30 08:30:00'
    },
    // 6. OPEN LOW - Assigned to Admin
    {
      user_id: 6, // Pooja Kaplesh
      assigned_to: 1, // Admin
      subject: 'Vendor TREDS onboarding checklist instruction typo',
      description: 'Step 4 references outdated portal URL. Please update link to https://www.treds-portal.in',
      category: 'other',
      priority: 'low',
      status: 'open',
      module: 'Vendors',
      attachment_link: null,
      deadline_date: '2026-11-06',
      created_at: '2026-10-26 14:10:00'
    },
    // 7. SUBMITTED UNDER REVIEW - Assigned to Rahul Sharma
    {
      user_id: 1, // Admin
      assigned_to: 5, // Rahul Sharma
      subject: 'Material Indent dispatch quantity validation warning',
      description: 'Dispatch quantity should not exceed approved indent quantity by more than 5% without supervisor sign-off.',
      category: 'bug',
      priority: 'medium',
      status: 'submitted',
      module: 'Purchase & Inventory',
      attachment_link: JSON.stringify(['/uploads/1790073317909-tvqrm2-Screenshot_2026-09-22_142607.jpg']),
      proof_url: JSON.stringify(['/uploads/1790073992896-rcjjk0-Aging_Column_Proof.jpg']),
      proof_notes: 'Added client-side modal warning and backend guard check in dispatchReceiving route.',
      proof_submitted_at: '2026-10-30 11:15:00',
      proof_submitted_by: 5,
      deadline_date: '2026-11-01',
      created_at: '2026-10-28 15:00:00'
    },
    // 8. RESOLVED - Assigned to Admin
    {
      user_id: 3, // Rajat Sharma
      assigned_to: 1, // Admin
      subject: 'Add quick phone dial link on CRM Lead card view',
      description: 'Make telephone numbers tel: links so sales managers on mobile can dial client directly.',
      category: 'feature_request',
      priority: 'medium',
      status: 'resolved',
      module: 'CRM Funnel',
      attachment_link: null,
      resolved_by: 1,
      resolved_at: '2026-10-29 17:30:00',
      admin_response: 'Implemented tel: clickable anchor tags on mobile viewport cards.',
      deadline_date: '2026-10-29',
      created_at: '2026-10-25 11:20:00'
    },
    // 9. RESOLVED - Assigned to Nancy
    {
      user_id: 6, // Pooja Kaplesh
      assigned_to: 4, // Nancy
      subject: 'Collection reminder email template missing GSTIN breakdown',
      description: 'Overdue invoice reminders now require CGST/SGST/IGST breakdown in the reminder summary table.',
      category: 'payment',
      priority: 'high',
      status: 'resolved',
      module: 'Billing & Collections',
      attachment_link: JSON.stringify(['/uploads/1788600075018-dv1z8x-Screenshot_2026-08-27_132710.png']),
      resolved_by: 1,
      resolved_at: '2026-10-28 16:00:00',
      admin_response: 'Updated email HTML template with 3-column GST split.',
      deadline_date: '2026-10-28',
      created_at: '2026-10-24 10:00:00'
    },
    // 10. CLOSED - Assigned to Admin
    {
      user_id: 5, // Rahul Sharma
      assigned_to: 1, // Admin
      subject: 'Solar inverter warranty serial number search lookup',
      description: 'Allow searching by serial number across dispatched inverter stock.',
      category: 'feature_request',
      priority: 'low',
      status: 'closed',
      module: 'Solar Projects',
      attachment_link: null,
      resolved_by: 1,
      resolved_at: '2026-10-22 14:00:00',
      admin_response: 'Added serial_no search index in stock lookup table.',
      deadline_date: '2026-10-22',
      created_at: '2026-10-20 09:15:00'
    },
    // 11. REJECTED - Assigned to Admin
    {
      user_id: 7, // Vikas Singh
      assigned_to: 1, // Admin
      subject: 'Request direct SSH access to SQLite production database',
      description: 'Need raw DB access to run ad-hoc bulk delete queries for test punch data.',
      category: 'access_issue',
      priority: 'high',
      status: 'rejected',
      module: 'System',
      attachment_link: null,
      reject_reason: 'Direct SSH and database console access is restricted to IT administrators. Use the Admin Data Management UI instead.',
      deadline_date: '2026-10-29',
      created_at: '2026-10-28 14:00:00'
    },
    // 12. OPEN URGENT - Overdue - Assigned to Admin
    {
      user_id: 4, // Nancy
      assigned_to: 1, // Admin
      subject: 'Payroll bonus calculation formula rounding difference',
      description: 'Festive advance deduction leaves 50 paisa fraction causing bank NEFT file batch rejection.',
      category: 'data_issue',
      priority: 'urgent',
      status: 'open',
      module: 'Payroll',
      attachment_link: JSON.stringify(['/uploads/1790074163159-ka8p3b-Aging_Column_Proof.jpg']),
      deadline_date: '2026-10-29', // Overdue
      created_at: '2026-10-28 16:30:00'
    },
    // 13. IN PROGRESS MEDIUM - Assigned to Admin
    {
      user_id: 3, // Rajat Sharma
      assigned_to: 1, // Admin
      subject: 'DPR daily progress report photo upload compression speed',
      description: 'Site engineers uploading 10MB camera photos experiencing slow timeouts on 4G network.',
      category: 'how_to',
      priority: 'medium',
      status: 'in_progress',
      module: 'DPR & Labour',
      attachment_link: JSON.stringify(['/uploads/1790073992853-a3tjf0-Screenshot_2026-09-22_142607.jpg']),
      deadline_date: '2026-11-02',
      created_at: '2026-10-29 11:45:00'
    },
    // 14. SUBMITTED UNDER REVIEW - Assigned to Vikas Singh
    {
      user_id: 1, // Admin
      assigned_to: 7, // Vikas Singh
      subject: 'Client Snag list rectification photo proof at Pune Site C',
      description: 'Need clear photographic proof of rectified cable conduit sealing before client inspection.',
      category: 'bug',
      priority: 'high',
      status: 'submitted',
      module: 'Client Snags',
      attachment_link: JSON.stringify(['/uploads/1790073992937-gv3lek-Site_Readiness___Client_Snag_Proof.jpg']),
      proof_url: JSON.stringify([
        '/uploads/1790073992969-ioab4z-Drawing_Tracker_Proof.jpg',
        '/uploads/1790073992896-rcjjk0-Aging_Column_Proof.jpg'
      ]),
      proof_notes: 'All 6 conduit junction boxes sealed and reinspected with site consultant signature.',
      proof_submitted_at: '2026-10-30 15:45:00',
      proof_submitted_by: 7,
      deadline_date: '2026-10-30',
      created_at: '2026-10-27 15:20:00'
    },
    // 15. RESOLVED - Assigned to Admin
    {
      user_id: 1, // Admin
      assigned_to: 1, // Admin
      subject: 'Daily Standup afternoon summary WhatsApp notification failure',
      description: 'Cron scheduler was missing phone number country code prefix for 3 site engineers.',
      category: 'bug',
      priority: 'medium',
      status: 'resolved',
      module: 'Daily Standup',
      attachment_link: null,
      resolved_by: 1,
      resolved_at: '2026-10-27 18:00:00',
      admin_response: 'Added default +91 prefix sanitization in notification worker.',
      deadline_date: '2026-10-27',
      created_at: '2026-10-26 12:00:00'
    },
    // 16. OPEN HIGH - Assigned to Rajat
    {
      user_id: 1, // Admin
      assigned_to: 3, // Rajat Sharma
      subject: 'Lead stage conversion probability indicator on Sales Kanban',
      description: 'Display win-probability percentage badge directly on CRM deals in negotiation stage.',
      category: 'feature_request',
      priority: 'high',
      status: 'open',
      module: 'CRM Funnel',
      attachment_link: JSON.stringify(['/uploads/1790073653618-mcj1c1-Screenshot_2026-09-22_142607.jpg']),
      deadline_date: '2026-11-04',
      created_at: '2026-10-30 10:00:00'
    }
  ];

  const insert = db.prepare(`
    INSERT INTO support_tickets (
      ticket_no, user_id, subject, description, category, priority, status,
      attachment_link, module, assigned_to, deadline_date,
      proof_url, proof_notes, proof_submitted_at, proof_submitted_by,
      resolved_by, resolved_at, admin_response, reject_reason, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?
    )
  `);

  const insertMany = db.transaction((tickets) => {
    for (const t of tickets) {
      const tktNo = nextSequence(db, 'support_tickets', 'ticket_no', 'TK-', { startFrom: 1000, pad: 5 });
      insert.run(
        tktNo,
        t.user_id,
        t.subject,
        t.description,
        t.category,
        t.priority,
        t.status,
        t.attachment_link || null,
        t.module || null,
        t.assigned_to || null,
        t.deadline_date || null,
        t.proof_url || null,
        t.proof_notes || null,
        t.proof_submitted_at || null,
        t.proof_submitted_by || null,
        t.resolved_by || null,
        t.resolved_at || null,
        t.admin_response || null,
        t.reject_reason || null,
        t.created_at,
        t.created_at
      );
    }
  });

  insertMany(sampleTickets);
  console.log(`Successfully inserted ${sampleTickets.length} sample support tickets.`);

  const total = db.prepare('SELECT COUNT(*) as c FROM support_tickets').get().c;
  console.log(`Total tickets in database: ${total}`);

  const byStatus = db.prepare('SELECT status, COUNT(*) as count FROM support_tickets GROUP BY status').all();
  console.log('Status breakdown:', byStatus);

  const byPriority = db.prepare('SELECT priority, COUNT(*) as count FROM support_tickets GROUP BY priority').all();
  console.log('Priority breakdown:', byPriority);
}

seedTickets();
