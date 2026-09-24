const express = require('express');
const {getDb} = require('../db/schema');
const {authMiddleware,requirePermission} = require('../middleware/auth');
const {report,validateAdjustment,validDate,BASES} = require('../lib/projectProfit');
const router=express.Router();
router.use(authMiddleware,requirePermission('project_profit','view'));
router.get('/',(req,res)=>{
  const {basis='sales',from='',to=''}=req.query;
  if (!BASES.includes(basis) || (from&&!validDate(from)) || (to&&!validDate(to)) || (from&&to&&from>to)) return res.status(400).json({error:'Select a valid basis and date range'});
  try {res.json(report(getDb(),{basis,from,to}));} catch(e) {console.error('[project-profit]',e.message);res.status(500).json({error:'Could not load project profit and loss. Try again.'});}
});
router.post('/adjustments',requirePermission('project_profit','create'),(req,res)=>{
  const error=validateAdjustment(req.body);if(error)return res.status(400).json({error});
  const db=getDb(),b=req.body;
  if(!db.prepare('SELECT id FROM business_book WHERE id=?').get(b.project_id))return res.status(404).json({error:'Project not found'});
  const r=db.prepare(`INSERT INTO project_profit_adjustments(project_id,basis,kind,category,entry_date,amount,reason,created_by) VALUES(?,?,?,?,?,?,?,?)`)
    .run(b.project_id,b.basis,b.kind,b.category,b.entry_date,b.amount,b.reason.trim(),req.user.id);
  res.status(201).json({id:r.lastInsertRowid});
});
router.post('/adjustments/:id/void',requirePermission('project_profit','delete'),(req,res)=>{
  const reason=req.body.reason;
  if(typeof reason!=='string'||reason.trim().length<5||reason.length>1000)return res.status(400).json({error:'Enter a reason for voiding (5–1000 characters)'});
  const r=getDb().prepare(`UPDATE project_profit_adjustments SET voided_at=CURRENT_TIMESTAMP,voided_by=?,void_reason=? WHERE id=? AND voided_at IS NULL`).run(req.user.id,reason.trim(),req.params.id);
  if(!r.changes)return res.status(409).json({error:'Adjustment not found or already voided'});
  res.json({ok:true});
});
module.exports=router;
