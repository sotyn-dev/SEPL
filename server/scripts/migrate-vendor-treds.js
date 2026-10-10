// Default is a dry run on an online SQLite backup. This never starts ERP services.
const fs=require('fs');
const path=require('path');
const Database=require('better-sqlite3');
const {ensureVendorTredsSchema}=require('../db/vendorTredsSchema');
const {getDefaultConfig}=require('../lib/vendorTreds/kpis');
function counts(db){return Object.fromEntries(['customers','vendors','crm_funnel','sales_bills','receivables','collections','pms_tasks'].map(t=>[t,db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n]));}
function runModuleMigration(db){
  ensureVendorTredsSchema(db);
  db.prepare("INSERT INTO app_settings(key,value) VALUES('vendor_treds_settings',?) ON CONFLICT(key) DO NOTHING").run(JSON.stringify(getDefaultConfig()));
}
async function main(){
  const args=process.argv.slice(2),apply=args.includes('--apply');
  const source=path.resolve(args.find(a=>!a.startsWith('--'))||path.join(__dirname,'../../data/erp.db'));
  if(!fs.existsSync(source))throw new Error('Database file not found');
  const folder=path.resolve(__dirname,'../../outputs/vendor-treds-migration');fs.mkdirSync(folder,{recursive:true});
  const backup=path.join(folder,`${Date.now()}-${apply?'before-apply':'dry-run'}.db`);
  const reader=new Database(source,{readonly:true,fileMustExist:true});
  await reader.backup(backup);reader.close();
  const target=apply?source:backup,db=new Database(target,{fileMustExist:true});db.pragma('foreign_keys = ON');
  try{
    const before=counts(db),baseline=db.pragma('foreign_key_check').length;
    runModuleMigration(db);const first=counts(db);
    runModuleMigration(db);const after=counts(db),errors=db.pragma('foreign_key_check').filter(r=>String(r.table).startsWith('vt_'));
    if(JSON.stringify(before)!==JSON.stringify(first)||JSON.stringify(first)!==JSON.stringify(after))throw new Error('Migration changed existing business row counts');
    if(errors.length)throw new Error('Module foreign-key validation failed');
    const collisions={};for(const col of ['pan','gst_number','website_domain'])collisions[col]=db.prepare(`SELECT COUNT(*) n FROM (SELECT LOWER(TRIM(${col})) FROM customers WHERE NULLIF(TRIM(${col}),'') IS NOT NULL GROUP BY LOWER(TRIM(${col})) HAVING COUNT(*)>1)`).get().n;
    const result={mode:apply?'apply':'dry-run',source,target,backup,existing_rows:after,baseline_foreign_key_issues:baseline,module_foreign_key_issues:errors.length,
      identity_collision_groups:collisions,repeatable:true,transactions_seeded:false,catalog_count:db.prepare('SELECT COUNT(*) n FROM vt_catalog').get().n};
    fs.writeFileSync(path.join(folder,'latest-report.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
  }finally{db.close();}
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={runModuleMigration,counts};
