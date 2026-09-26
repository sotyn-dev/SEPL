const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const bcrypt=require('bcryptjs');
const Database=require('better-sqlite3');
function fixture() {
  const db=new Database(':memory:');
  db.exec('CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT,email TEXT,username TEXT,password TEXT,role TEXT,department TEXT,active INTEGER)');
  for(const name of ['nancy','rahul']) db.prepare('INSERT INTO users(name,email,username,password,active) VALUES(?,?,?,?,?)').run(name,`${name}@securedengineers.com`,name,bcrypt.hashSync('Changed-test-password',4),1);
  return db;
}
test('startup seeds preserve reset passwords, renamed usernames and disabled accounts across restarts',()=>{
  const db=fixture();db.exec("UPDATE users SET username='nancy-new',active=0 WHERE name='nancy'");
  const before=db.prepare('SELECT * FROM users ORDER BY id').all();
  const source=fs.readFileSync(path.join(__dirname,'../../db/schema.js'),'utf8');
  const start=source.indexOf('  // Seed / ensure Nancy Compliance Monitor user');
  const end=source.indexOf('  // ============================================',start);
  assert.ok(start>=0&&end>start);
  for(let i=0;i<2;i++)vm.runInNewContext(source.slice(start,end),{db,bcrypt});
  assert.deepEqual(db.prepare('SELECT * FROM users ORDER BY id').all(),before);db.close();
});
test('login accepts the reset password, rejects old defaults and cannot reactivate or create users',async()=>{
  const db=fixture();let login;
  const source=fs.readFileSync(path.join(__dirname,'../../routes/auth.js'),'utf8');
  const start=source.indexOf("router.post('/login',");const end=source.indexOf("router.post('/login/totp',",start);
  vm.runInNewContext(source.slice(start,end),{router:{post:(_path,fn)=>login=fn},bcrypt,getDb:()=>db,
    require:()=>({logAuditEvent:()=>{}}),totp:{get:()=>null,needsTotp:()=>false},finishLogin:(res,user)=>res.json({id:user.id})});
  async function attempt(username,password) {
    const res={code:200,status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
    await login({body:{username,password},headers:{}},res);return res;
  }
  for(const [name,old] of [['nancy','Nancy@123456'],['rahul','User@123456']]) {
    assert.equal((await attempt(name,'Changed-test-password')).code,200);
    assert.equal((await attempt(name,old)).code,401);
    assert.ok(bcrypt.compareSync('Changed-test-password',db.prepare('SELECT password FROM users WHERE name=?').get(name).password));
  }
  db.exec("UPDATE users SET active=0 WHERE name='nancy'");
  assert.equal((await attempt('nancy','Changed-test-password')).code,403);
  assert.equal((await attempt('nancy','Nancy@123456')).code,401);
  assert.equal(db.prepare("SELECT active FROM users WHERE name='nancy'").get().active,0);
  db.exec("DELETE FROM users WHERE name='rahul'");
  assert.equal((await attempt('rahul','User@123456')).code,401);
  assert.equal(db.prepare("SELECT count(*) n FROM users WHERE name='rahul'").get().n,0);db.close();
});
