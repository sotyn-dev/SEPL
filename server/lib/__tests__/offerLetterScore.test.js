const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { countOfferLetters, initialize } = require('../offerLetterScore');

function fixture() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE candidates(id INTEGER PRIMARY KEY, status TEXT, created_at TEXT, offer_sent_at TEXT, offer_letter_file TEXT);
    CREATE TABLE candidate_events(candidate_id INTEGER,event_type TEXT,created_at TEXT);
    CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE score_kpis(id INTEGER PRIMARY KEY,metric_name TEXT,data_source TEXT,default_planned REAL);
    CREATE TABLE score_user_kpi_target(user_id INTEGER,kpi_id INTEGER,planned_value REAL);`);
  return db;
}

test('counts actual letters in their issue week, not candidate creation or shortlisting', () => {
  const db = fixture();
  db.exec(`INSERT INTO candidates VALUES
    (1,'offer_sent','2026-08-01','2026-09-15T10:00:00Z',NULL),
    (2,'onboarded','2026-08-01','2026-09-18T10:00:00Z',NULL),
    (3,'interview_scheduled','2026-09-15',NULL,NULL),
    (4,'applied','2026-09-15',NULL,NULL),
    (5,'rejected','2026-08-01','2026-09-19T10:00:00Z',NULL),
    (6,'offer_sent','2026-09-15','invalid',NULL);
    INSERT INTO candidate_events VALUES
    (1,'offer_generated','2026-09-15 10:00:00'),
    (2,'offer_generated','2026-09-18 10:00:00'),
    (2,'finalised','2026-09-21 10:00:00');`);
  assert.equal(countOfferLetters(db,'2026-09-14','2026-09-19'),3);
  assert.equal(countOfferLetters(db,'2026-09-21','2026-09-26'),0);
  db.close();
});

test('repeated generations or overwritten legacy dates do not move or duplicate the first issue', () => {
  const db = fixture();
  db.exec(`INSERT INTO candidates VALUES(1,'offer_sent','2026-08-01','2026-09-23T12:00:00Z',NULL);
    INSERT INTO candidate_events VALUES
    (1,'offer_generated','2026-09-15 10:00:00'),
    (1,'offer_generated','2026-09-23 12:00:00');`);
  assert.equal(countOfferLetters(db,'2026-09-14','2026-09-19'),1);
  assert.equal(countOfferLetters(db,'2026-09-21','2026-09-26'),0);
  db.close();
});

test('IST week boundaries include Monday through Saturday exactly', () => {
  const db = fixture();
  const add = db.prepare("INSERT INTO candidates VALUES(?,'offer_sent','2026-08-01',?,NULL)");
  for (const [id, at] of [
    [1,'2026-09-20T18:29:59Z'], [2,'2026-09-20T18:30:00Z'],
    [3,'2026-09-26 18:29:59'], [4,'2026-09-26 18:30:00'],
    [5,'2026-09-21T00:00:00+05:30'],
  ]) add.run(id,at);
  assert.equal(countOfferLetters(db,'2026-09-21','2026-09-26'),3);
  db.close();
});

test('legacy uploads count once with generated offers and missing dates are not guessed', () => {
  const db = fixture();
  const file = `/uploads/${Date.parse('2025-09-16T10:00:00Z')}-offer.pdf`;
  const add = db.prepare("INSERT INTO candidates VALUES(?,'offer_sent','2025-09-01',?,?)");
  add.run(1,null,file);
  add.run(2,'2025-09-18T10:00:00Z',file);
  add.run(3,null,'/uploads/unknown-date.pdf');
  add.run(4,null,'   ');
  db.exec("INSERT INTO candidate_events VALUES(2,'offer_generated','2025-09-18 10:00:00')");
  assert.equal(countOfferLetters(db,'2025-09-15','2025-09-20'),2);
  db.close();
});

test('migration changes only the Offer Letter source and preserves target 3 and other settings', () => {
  const db = fixture();
  db.exec(`INSERT INTO score_kpis VALUES
    (424,'Offer Letter','auto:candidates_shortlisted',0),
    (425,'Shortlisted','auto:candidates_shortlisted',7),
    (426,'Offer Letter','manual',5);
    INSERT INTO score_user_kpi_target VALUES(29,424,3);`);
  initialize(db);
  initialize(db);
  assert.deepEqual(db.prepare('SELECT data_source,default_planned FROM score_kpis WHERE id=424').get(),
    {data_source:'auto:offer_letters',default_planned:0});
  assert.equal(db.prepare('SELECT planned_value FROM score_user_kpi_target WHERE user_id=29').get().planned_value,3);
  assert.equal(db.prepare('SELECT data_source FROM score_kpis WHERE id=425').get().data_source,'auto:candidates_shortlisted');
  assert.equal(db.prepare('SELECT data_source FROM score_kpis WHERE id=426').get().data_source,'manual');
  db.close();
});
