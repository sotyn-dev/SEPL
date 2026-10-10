const fs=require('node:fs');
const path=require('node:path');
const Database=require('better-sqlite3');
const {ensureVendorTredsSchema}=require('../../../db/vendorTredsSchema');
function fixture(){
  const db=new Database(':memory:');db.pragma('foreign_keys=ON');
  const source=fs.readFileSync(path.join(__dirname,'../../../db/schema.js'),'utf8');
  for(const table of ['users','lead_sources','leads','boq','quotations','purchase_orders','business_book','customers','vendors','crm_funnel','sales_bills','receivables','collections','pms_tasks','app_settings','roles','role_permissions','user_roles','notifications']){
    const ddl=source.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\s*\\);`))?.[0];
    if(!ddl)throw new Error('Missing base fixture schema: '+table);db.exec(ddl);
  }
  for(const table of ['bank_accounts','bank_transactions'])db.exec(source.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\s*\\)`))[0]);
  require('../../../db/dailyWork').initialize(db);
  db.exec(`ALTER TABLE users ADD COLUMN manager_id INTEGER;ALTER TABLE users ADD COLUMN archived INTEGER DEFAULT 0;
    ALTER TABLE role_permissions ADD COLUMN can_see_all INTEGER DEFAULT 0;
    ALTER TABLE quotations ADD COLUMN crm_funnel_id INTEGER;ALTER TABLE quotations ADD COLUMN business_book_id INTEGER;
    ALTER TABLE sales_bills ADD COLUMN customer_name TEXT;ALTER TABLE sales_bills ADD COLUMN created_by INTEGER;
    ALTER TABLE sales_bills ADD COLUMN approval_status TEXT DEFAULT 'draft';
    INSERT INTO users(id,name,email,password,role) VALUES(1,'Test Administrator','admin@example.invalid','fixture','admin'),
      (2,'Test Owner','owner@example.invalid','fixture','user'),(3,'Other Test Owner','other@example.invalid','fixture','user'),
      (4,'Test Reviewer','reviewer@example.invalid','fixture','user');UPDATE users SET manager_id=4 WHERE id=2;
    INSERT INTO roles(id,name) VALUES(1,'Test View'),(2,'Test Edit'),(3,'Test Reviewer');
    INSERT INTO user_roles(user_id,role_id) VALUES(2,1),(2,2),(4,3);
    INSERT INTO role_permissions(role_id,module,can_view,can_create,can_edit,can_approve,can_see_all) VALUES
      (1,'vendor_registrations',1,0,0,0,0),(2,'vendor_registrations',0,1,1,0,0),
      (1,'vendor_treds_dashboard',1,0,0,0,0),(3,'vendor_registrations',1,1,1,1,0),
      (3,'vendor_treds_dashboard',1,1,1,1,0);`);
  ensureVendorTredsSchema(db);
  return db;
}
module.exports={fixture};
