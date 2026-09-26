const { tsMs } = require('../utils/raciModules');
// Use the actual Sales Funnel tab, rather than inferring a stage from old stamps.
const stages = {
  qualification:['Qualified or Not',['qualified']],site_survey:['Site Survey + Feasibility',['meeting','mom']],
  concept_design:['Concept Design / Drawings',['drawing']],boq_costing:['BOQ + Vendor Costing',['boq']],
  quote_submitted:['Quote / Bid Submission',['quotation']],contract_signed:['Contract + LOI / PO',['result']],
};
const legacy={qualified:'qualification',meeting_assigned:'site_survey',mom_uploaded:'site_survey',drawing_uploaded:'concept_design',boq_created:'boq_costing',quotation_sent:'quote_submitted',won:'contract_signed'};
function dashboardSalesRecords(db,userId) {
  const configs=db.prepare("SELECT * FROM raci_assignment WHERE module='sales_funnel'").all();
  const map=new Map(configs.map(c=>[`${c.record_id}:${c.step_key}`,c]));
  const names=new Map(db.prepare('SELECT id,name FROM users').all().map(u=>[u.id,u.name]));
  const rows=[];
  for(const rec of db.prepare('SELECT * FROM sales_funnel').all()) {
    const stage=legacy[rec.current_stage]||rec.current_stage;
    const definition=stages[stage];if(!definition)continue;
    const matches=[];
    for(const key of definition[1]) {
      const cfg=map.get(`${rec.id}:${key}`)||{},base=map.get(`0:${key}`)||{};
      if(base.step_enabled===0||cfg.step_enabled===0)continue;
      const roles=['responsible','accountable'].filter(role=>Number(cfg[`${role}_id`]||base[`${role}_id`])===userId);
      if(!roles.length)continue;
      matches.push({key,roles,responsible: names.get(cfg.responsible_id||base.responsible_id),accountable:names.get(cfg.accountable_id||base.accountable_id),sla:cfg.sla_hours??base.sla_hours});
    }
    if(!matches.length)continue;
    const entered=tsMs(rec.stage_entered_at||rec.created_at);
    const slas=matches.map(m=>m.sla).filter(s=>s!=null&&Number.isFinite(Number(s))).map(Number);
    const sla=slas.length?Math.min(...slas):null;
    rows.push({key:`sales_funnel:${rec.id}:${stage}`,module:'sales_funnel',module_label:'Sales Funnel',record_id:rec.id,
      title:rec.lead_no||`Lead #${rec.id}`,subtitle:rec.client_name||'',company:rec.company_name||'',category:rec.category||'',
      location:[rec.district,rec.state].filter(Boolean).join(', '),amount:rec.tentative_amount,coordinator:rec.assigned_sc||'',
      step:definition[0],stage,roles:[...new Set(matches.flatMap(m=>m.roles))],current:true,
      responsible:[...new Set(matches.map(m=>m.responsible).filter(Boolean))].join(', '),accountable:[...new Set(matches.map(m=>m.accountable).filter(Boolean))].join(', '),
      started_at:entered!=null?new Date(entered).toISOString():null,due_at:entered!=null&&sla!=null?new Date(entered+sla*3600000).toISOString():null,sla_hours:sla,
      path:`/leads?tab=list&stage=${encodeURIComponent(stage)}`});
  }
  return rows;
}
module.exports={dashboardSalesRecords};
