const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { dailyActiveUsers, ensureEngagementTable, qualifiesPath, recordView } = require('../userEngagement');
const db = new Database(':memory:');
db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, active INTEGER, archived INTEGER);
CREATE TABLE audit_log (user_id INTEGER, at TEXT, path TEXT, entity_type TEXT, action TEXT, status_code INTEGER);
INSERT INTO users VALUES (1,1,0),(2,1,0),(3,1,0),(4,1,1),(5,0,0);
INSERT INTO audit_log VALUES
 (1,'2026-09-20 19:00:00','/api/business-book/1','business-book','UPDATE',200),
 (1,'2026-09-21 05:00:00','/api/leads','leads','CREATE',201),
 (2,'2026-09-21 05:00:00','/api/attendance/punch-in','attendance','CREATE',200),
 (2,'2026-09-21 06:00:00','/api/auth/login','auth','LOGIN',200),
 (2,'2026-09-21 06:00:00','/api/auth/engagement','auth','CREATE',204),
 (2,'2026-09-21 06:00:00','/api/push/subscribe','push','CREATE',200),
 (3,'2026-09-21 05:00:00','/api/leads','leads','UPDATE',500),
 (4,'2026-09-21 05:00:00','/api/leads','leads','UPDATE',200),
 (5,'2026-09-21 05:00:00','/api/leads','leads','UPDATE',200),
 (1,'2026-09-26 19:00:00','/api/leads','leads','UPDATE',200);
`);
assert.deepEqual(dailyActiveUsers(db,'2026-09-21','2026-09-26','2026-09-21'), {given:3,done:1});
ensureEngagementTable(db);
db.exec("INSERT INTO user_engagement_days VALUES ('2026-09-21',1),('2026-09-21',2),('2026-09-21',3),('2026-09-21',4),('2026-09-22',2)");
assert.deepEqual(dailyActiveUsers(db,'2026-09-21','2026-09-26','2026-09-21'), {given:3,done:3});
assert.deepEqual(dailyActiveUsers(db,'2026-09-21','2026-09-26','2026-09-22'), {given:3,done:2});
assert.deepEqual(dailyActiveUsers(db,'2026-09-21','2026-09-26','2026-09-28'), {given:3,done:1});
assert.deepEqual(dailyActiveUsers(db,'2026-10-05','2026-10-10','2026-09-28'), {given:3,done:0});
for (const path of ['/attendance','/attendance?tab=history','/api/attendance/punch-out','/admin/locations','/api/auth/login','/api/push/subscribe','https://example.com','//example.com']) assert.equal(qualifiesPath(path),false,path);
for (const path of ['/business-book','/item-master','/employees','/admin/users','/scorecard','/api/leads/1']) assert.equal(qualifiesPath(path),true,path);
assert.equal(recordView(db,1,'/attendance'),false);
assert.equal(recordView(db,1,'/business-book'),true);
assert.equal(recordView(db,1,'/business-book'),true);
assert.equal(db.prepare("SELECT COUNT(*) c FROM user_engagement_days WHERE day=date('now','+5 hours','+30 minutes') AND user_id=1").get().c,1);
db.exec("INSERT INTO audit_log VALUES (3,'2026-09-26T18:00:00.000Z','/api/leads','leads','UPDATE',200)");
assert.deepEqual(dailyActiveUsers(db,'2026-09-26','2026-09-26','2026-09-28'), {given:3,done:1});
db.close();
console.log('ERP engagement checks passed');
