// Use the existing asset assignment and movement ledger as the single source.
function assignVehicle(db, { userId, assetId, actorId, canEditAssets }) {
  if (assetId === undefined) return;
  const targetId = assetId === '' || assetId == null ? null : Number(assetId);
  if (targetId != null && (!Number.isSafeInteger(targetId) || targetId <= 0)) throw new Error('Select a valid vehicle');
  if (!userId) {
    if (targetId != null) throw new Error('Link a login user before allotting a vehicle');
    return;
  }
  const current = db.prepare("SELECT * FROM company_assets WHERE category='Vehicle' AND current_user_id=? AND status='issued'").all(userId);
  if ((targetId == null && !current.length) || (current.length === 1 && current[0].id === targetId)) return;
  if (!canEditAssets) throw new Error('Company Assets edit permission is required to change vehicle allotment');
  const user = db.prepare('SELECT id, name FROM users WHERE id=?').get(userId);
  if (!user) throw new Error('Linked login user does not exist');
  let target;
  if (targetId != null) {
    target = db.prepare("SELECT * FROM company_assets WHERE id=? AND category='Vehicle'").get(targetId);
    if (!target || !(target.status === 'available' || (target.status === 'issued' && target.current_user_id === Number(userId)))) throw new Error('Vehicle is unavailable or already allotted to another user');
    if (target.status === 'available' && target.current_user_id && target.current_user_id !== Number(userId)) throw new Error('Vehicle has another assignee; reconcile it in Company Assets first');
  }
  for (const asset of current.filter(a => a.id !== targetId)) {
    db.prepare("UPDATE company_assets SET status='available', current_user_id=NULL, current_user_name=NULL, returned_at=CURRENT_TIMESTAMP WHERE id=?").run(asset.id);
    db.prepare("INSERT INTO company_asset_movements (asset_id,movement_type,from_user_id,notes,performed_by) VALUES (?,'return',?,?,?)").run(asset.id, userId, 'Returned from employee vehicle allotment', actorId);
  }
  if (target && !current.some(a => a.id === targetId)) {
    db.prepare("UPDATE company_assets SET status='issued',current_user_id=?,current_user_name=?,issued_at=CURRENT_TIMESTAMP,returned_at=NULL WHERE id=?").run(userId, user.name, targetId);
    db.prepare("INSERT INTO company_asset_movements (asset_id,movement_type,to_user_id,notes,performed_by) VALUES (?,'issue',?,?,?)").run(targetId, userId, 'Allotted from employee form', actorId);
  }
}
function assignEquipment(db, { userId, assetIds, actorId, canEditAssets }) {
  if (assetIds === undefined) return;
  if (!Array.isArray(assetIds) || assetIds.length > 200 || assetIds.some(id => !Number.isSafeInteger(id) || id <= 0) || new Set(assetIds).size !== assetIds.length) throw new Error('Select valid equipment assets');
  if (!userId) {
    if (assetIds.length) throw new Error('Link a login user before assigning equipment');
    return;
  }
  const current = db.prepare("SELECT * FROM company_assets WHERE COALESCE(category,'') <> 'Vehicle' AND current_user_id=? AND status='issued'").all(userId);
  if (current.length === assetIds.length && current.every(a => assetIds.includes(a.id))) return;
  if (!canEditAssets) throw new Error('Company Assets edit permission is required to change equipment assignments');
  const user = db.prepare('SELECT id,name FROM users WHERE id=?').get(userId);
  if (!user) throw new Error('Linked login user does not exist');
  const selected = assetIds.map(id => {
    const a = db.prepare('SELECT * FROM company_assets WHERE id=?').get(id);
    if (!a || a.category === 'Vehicle' || !['available','issued'].includes(a.status) ||
        (a.current_user_id && Number(a.current_user_id) !== Number(userId)) ||
        (a.status === 'issued' && Number(a.current_user_id) !== Number(userId))) throw new Error('An equipment asset is unavailable or assigned to another employee');
    return a;
  });
  for (const a of current.filter(a => !assetIds.includes(a.id))) {
    db.prepare("UPDATE company_assets SET status='available',current_user_id=NULL,current_user_name=NULL,returned_at=CURRENT_TIMESTAMP WHERE id=?").run(a.id);
    db.prepare("INSERT INTO company_asset_movements (asset_id,movement_type,from_user_id,notes,performed_by) VALUES (?,'return',?,?,?)").run(a.id,userId,'Returned from employee form',actorId);
  }
  for (const a of selected.filter(a => !current.some(c => c.id === a.id))) {
    db.prepare("UPDATE company_assets SET status='issued',current_user_id=?,current_user_name=?,issued_at=CURRENT_TIMESTAMP,returned_at=NULL WHERE id=?").run(userId,user.name,a.id);
    db.prepare("INSERT INTO company_asset_movements (asset_id,movement_type,to_user_id,notes,performed_by) VALUES (?,'issue',?,?,?)").run(a.id,userId,'Issued from employee form',actorId);
  }
}
module.exports = { assignVehicle, assignEquipment };
