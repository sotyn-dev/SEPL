const sources = {
  payables:['payment_required','/payment-required'],crm_funnel:['crm_funnel','/crm-funnel'],
  sales_funnel:['leads','/leads'],solar_funnel:['solar_quotation','/solar-funnel'],
  quotation:['quotations','/quotations'],indent_to_dispatch:['procurement','/procurement'],
  cheques:['cheques','/cheques'],subcon_hiring:['subcon_hiring','/subcon-hiring'],
  dpr:['dpr','/dpr'],sales_billing:['installation','/installation'],
  collections:['collections','/collections'],tally_bills:['procurement','/procurement'],
};
function personalRaciWork(db,user,permissions,buildBoard) {
  const rows=[],unavailable=[];
  for(const [module,[permission,path]] of Object.entries(sources)) {
    if(user.role!=='admin'&&!permissions[permission]?.can_view)continue;
    try {
      if(module==='sales_funnel') {
        rows.push(...require('./dashboardSalesRecords').dashboardSalesRecords(db,user.id));
        continue;
      }
      const board=buildBoard(db,module,{allRecords:true});
      for(const record of board?.rows || []) {
        const current=record.steps.find(s=>s.status==='current');
        if(!current)continue;
        for(const step of record.steps) {
          if(step.status!=='current')continue;
          const roles=['responsible','accountable'].filter(role=>Number(step[`${role}_id`])===user.id);
          if(!roles.length)continue;
          const start=step.started_at?Date.parse(step.started_at):NaN;
          const due=step.sla_hours!=null&&Number.isFinite(start)?new Date(start+step.sla_hours*3600000).toISOString():null;
          rows.push({key:`${module}:${record.id}:${step.key}`,module,module_label:board.label,record_id:record.id,title:record.title,subtitle:record.subtitle,
            step:step.label,roles,current:step.status==='current',waiting_on:step.status==='current'?null:current.label,
            responsible:step.responsible,accountable:step.accountable,started_at:step.started_at,due_at:due,sla_hours:step.sla_hours,path});
        }
      }
    } catch { unavailable.push(module); }
  }
  return {rows,unavailable};
}
module.exports={personalRaciWork};
