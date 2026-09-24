const router = require('express').Router();
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission, adminOnly } = require('../middleware/auth');
const logic = require('../lib/makeApproval');
router.use(authMiddleware);
router.get('/:poId',requirePermission('orders','view'),(req,res) => {
  const db=getDb(),po=db.prepare('SELECT id,business_book_id FROM purchase_orders WHERE id=?').get(req.params.poId);
  if(!po) return res.status(404).json({error:'Order not found'});
  const rows=db.prepare(`SELECT i.*,a.make AS selected_make,a.status AS make_status,a.item_hash,
    a.reviewed_at,u.name AS reviewed_by_name FROM po_items i
    LEFT JOIN po_make_approvals a ON a.po_id=? AND a.po_item_id=i.id
    LEFT JOIN users u ON u.id=a.reviewed_by
    WHERE i.po_id=? OR (i.po_id IS NULL AND i.business_book_id=?) ORDER BY i.sr_no,i.id`).all(po.id,po.id,po.business_book_id || -1);
  const makes=db.prepare("SELECT DISTINCT TRIM(make) make FROM item_master WHERE TRIM(COALESCE(make,''))<>'' ORDER BY make COLLATE NOCASE").all().map(r=>r.make);
  res.json({makes,items:rows.map(r=>({...r,make_status:r.item_hash && r.item_hash!==logic.hash(r)?'needs_resubmission':r.make_status || 'not_selected'}))});
});
router.put('/:poId/:itemId',requirePermission('orders','edit'),(req,res)=>{
  try { logic.selectMake(getDb(),+req.params.poId,+req.params.itemId,req.body.make,req.user.id);res.json({message:'Make submitted for approval'}); }
  catch(e){res.status(e.status||500).json({error:e.message});}
});
router.post('/:poId/:itemId/review',adminOnly,(req,res)=>{
  try { logic.review(getDb(),+req.params.poId,+req.params.itemId,req.body.status,req.user.id,req.body.make);res.json({message:'Review saved'}); }
  catch(e){res.status(e.status||500).json({error:e.message});}
});
module.exports=router;
