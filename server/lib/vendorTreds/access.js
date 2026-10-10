const MODULES = {
  dashboard: 'vendor_treds_dashboard', registrations: 'vendor_registrations',
  enquiries: 'vendor_enquiries', followups: 'vendor_enquiries', contacts: 'vendor_treds_masters',
  approvals: 'vendor_approvals', accounts: 'treds_accounts', mappings: 'treds_accounts',
  invoices: 'treds_invoices', funding: 'bill_discounting', reports: 'vendor_treds_reports',
  catalog: 'vendor_treds_masters', settings: 'vendor_treds_settings', tasks: 'vendor_treds_dashboard',
};
const ACTIONS = ['view','create','edit','delete','approve','see_all'];
function fail(message, status=403) { const e = new Error(message); e.status=status; throw e; }
function permissions(db, user) {
  if (!user?.id) fail('Sign in to continue',401);
  if (user.role === 'admin') return Object.fromEntries(Object.values(MODULES).map(m=>[m,Object.fromEntries(ACTIONS.map(a=>['can_'+a,1]))]));
  const rows=db.prepare(`SELECT rp.module, MAX(rp.can_view) can_view, MAX(rp.can_create) can_create,
    MAX(rp.can_edit) can_edit, MAX(rp.can_delete) can_delete, MAX(rp.can_approve) can_approve,
    MAX(rp.can_see_all) can_see_all FROM role_permissions rp JOIN user_roles ur ON ur.role_id=rp.role_id
    WHERE ur.user_id=? GROUP BY rp.module`).all(user.id);
  return Object.fromEntries(rows.map(r=>[r.module,r]));
}
function allowed(perms, kind, action='view') { return !!perms[MODULES[kind]]?.['can_'+action]; }
function requireAccess(perms, kind, action='view') { if (!allowed(perms,kind,action)) fail(`No ${action} permission for this module`); }
function scopeFor(db,user,perms,kind) {
  requireAccess(perms,kind);
  if(user.role==='admin'||allowed(perms,kind,'see_all')) return {ownerIds:null};
  // Approvers see their own records plus direct reports, not unrelated teams.
  const ownerIds=[Number(user.id)];
  if(allowed(perms,kind,'approve')) ownerIds.push(...db.prepare('SELECT id FROM users WHERE manager_id=?').all(user.id).map(r=>r.id));
  return {ownerIds:[...new Set(ownerIds)]};
}
function withinScope(scope,id) { return scope.ownerIds===null || scope.ownerIds.includes(Number(id)); }
function requireOwner(scope,id) { if(!withinScope(scope,id)) fail('Record is outside your assigned scope',404); }
module.exports={MODULES,ACTIONS,permissions,allowed,requireAccess,scopeFor,withinScope,requireOwner,fail};
