import{f as g,r as o,j as e}from"./react-vendor-j6k_rcxr.js";import{p as j}from"./index-CARKghJ1.js";import"./net-BOeqtr82.js";import"./socket-dm1FmSOd.js";const i={name:"SECURED ENGINEERS PVT. LTD.",head:"B.K Towers, Janta Nagar, Gill Road, Ludhiana, (PB) 141003",corp:"58/A/1, First Floor, Kalu Sarai, New Delhi - 110016",email:"Sales@securedengineers.com",website:"www.securedengineers.com"},t=n=>"Rs "+Number(n||0).toLocaleString("en-IN",{maximumFractionDigits:0});function w(){const{id:n}=g(),[d,h]=o.useState(null),[c,m]=o.useState(null);if(o.useEffect(()=>{j.get(`/indent-labour-payment/work-orders/${n}/print`).then(a=>h(a.data)).catch(a=>{var s,p;return m(((p=(s=a.response)==null?void 0:s.data)==null?void 0:p.error)||"Failed to load")})},[n]),c)return e.jsx("div",{className:"p-8 text-red-600",children:c});if(!d)return e.jsx("div",{className:"p-8 text-gray-400",children:"Loading…"});const r=d.work_order,l=d.labour||[],x=a=>{if(!a)return"—";const s=new Date(a);return isNaN(s)?a:`${String(s.getDate()).padStart(2,"0")}/${String(s.getMonth()+1).padStart(2,"0")}/${s.getFullYear()}`},b=l.reduce((a,s)=>a+(Number(s.amount)||0)+(Number(s.overtime_amount)||0),0);return e.jsxs("div",{className:"bg-white min-h-screen",children:[e.jsx("style",{children:`
        @media print {
          @page { size: A4 portrait; margin: 10mm; }
          body { margin: 0; }
          .no-print { display: none !important; }
          .wo-page { box-shadow: none !important; margin: 0 !important; }
          tr { page-break-inside: avoid; }
        }
        @media screen { body { background: #f3f4f6; } }
        .wo-page {
          max-width: 210mm; margin: 16px auto; background: white;
          box-shadow: 0 4px 20px rgba(0,0,0,0.1);
          font-family: 'Times New Roman', Times, serif; color: #111;
        }
        .header {
          display: flex; align-items: center; padding: 14px 24px 10px;
          border-bottom: 3px solid #c00; background: linear-gradient(to right, #fff 60%, #fef2f2);
        }
        .logo {
          width: 80px; height: 60px; flex-shrink: 0; background: white; border: 2px solid #c00;
          border-radius: 6px; display: flex; align-items: center; justify-content: center;
          font-weight: bold; color: #c00; font-size: 20px;
        }
        .name { flex: 1; padding-left: 14px; }
        .name h1 { font-size: 22px; font-weight: bold; color: #c00; margin: 0; letter-spacing: 0.5px; }
        .name p { font-size: 10px; color: #c00; margin: 2px 0 0; }
        .title-bar { background: #c00; color: white; padding: 6px 16px; font-weight: bold; font-size: 14px; letter-spacing: 1px; text-align: center; }
        .meta { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; padding: 10px 16px; font-size: 11px; border-bottom: 1px solid #ddd; }
        .meta div { background: #fef2f2; padding: 6px 10px; border-radius: 4px; }
        .meta .label { font-size: 9px; color: #888; text-transform: uppercase; }
        .meta .val { font-weight: bold; color: #111; }
        table.items { width: calc(100% - 32px); margin: 12px 16px; border-collapse: collapse; font-size: 11px; }
        table.items th { background: #c00; color: white; padding: 6px 8px; text-align: left; border: 1px solid #a00; }
        table.items td { padding: 5px 8px; border: 1px solid #ddd; vertical-align: top; }
        table.items tr:nth-child(even) td { background: #fafafa; }
        .footer { margin: 16px; padding-top: 8px; border-top: 2px dashed #ddd; display: flex; justify-content: space-between; font-size: 10px; color: #666; }
        .toolbar { position: fixed; top: 12px; right: 12px; z-index: 100; display: flex; gap: 8px; }
        .toolbar button { padding: 8px 14px; background: #dc2626; color: white; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; }
        .toolbar button.secondary { background: #6b7280; }
      `}),e.jsxs("div",{className:"toolbar no-print",children:[e.jsx("button",{onClick:()=>window.print(),children:"Print / Save PDF"}),e.jsx("button",{className:"secondary",onClick:()=>window.close(),children:"Close"})]}),e.jsxs("div",{className:"wo-page",children:[e.jsxs("div",{className:"header",children:[e.jsx("div",{className:"logo",children:"SE"}),e.jsxs("div",{className:"name",children:[e.jsx("h1",{children:i.name}),e.jsxs("p",{children:[e.jsx("strong",{children:"Head Office:"})," ",i.head]}),e.jsxs("p",{children:[e.jsx("strong",{children:"Corporate Office:"})," ",i.corp]})]})]}),e.jsx("div",{className:"title-bar",children:"WORK ORDER"}),e.jsxs("div",{className:"meta",children:[e.jsxs("div",{children:[e.jsx("div",{className:"label",children:"WO Number"}),e.jsx("div",{className:"val",children:r.wo_number||"—"})]}),e.jsxs("div",{children:[e.jsx("div",{className:"label",children:"Project"}),e.jsx("div",{className:"val",children:r.project_name||"—"})]}),e.jsxs("div",{children:[e.jsx("div",{className:"label",children:"Status"}),e.jsx("div",{className:"val",children:(r.status||"").replace("_"," ").toUpperCase()})]}),e.jsxs("div",{children:[e.jsx("div",{className:"label",children:"Sub-Contractor"}),e.jsx("div",{className:"val",children:r.sub_contractor_name||"—"})]}),e.jsxs("div",{children:[e.jsx("div",{className:"label",children:"Planned Start"}),e.jsx("div",{className:"val",children:x(r.planned_start)})]}),e.jsxs("div",{children:[e.jsx("div",{className:"label",children:"Planned End"}),e.jsx("div",{className:"val",children:x(r.planned_end)})]}),e.jsxs("div",{children:[e.jsx("div",{className:"label",children:"WO Value"}),e.jsx("div",{className:"val",children:t(r.planned_value)})]}),e.jsxs("div",{children:[e.jsx("div",{className:"label",children:"Amount Paid"}),e.jsx("div",{className:"val",children:t(r.amount_paid)})]}),e.jsxs("div",{children:[e.jsx("div",{className:"label",children:"Balance"}),e.jsx("div",{className:"val",children:t((r.planned_value||0)-(r.amount_paid||0))})]})]}),r.scope&&e.jsxs("div",{style:{padding:"10px 16px",fontSize:12},children:[e.jsx("strong",{children:"Scope of Work:"})," ",r.scope]}),l.length>0&&e.jsxs("table",{className:"items",children:[e.jsx("thead",{children:e.jsxs("tr",{children:[e.jsx("th",{children:"Category"}),e.jsx("th",{children:"Trade"}),e.jsx("th",{children:"Rate"}),e.jsx("th",{children:"Labourers"}),e.jsx("th",{children:"Days"}),e.jsx("th",{children:"OT Hrs"}),e.jsx("th",{children:"Amount"})]})}),e.jsxs("tbody",{children:[l.map(a=>e.jsxs("tr",{children:[e.jsx("td",{children:a.labour_category}),e.jsx("td",{children:a.trade||"—"}),e.jsxs("td",{children:[t(a.rate_snapshot),"/",a.unit]}),e.jsx("td",{children:a.quantity}),e.jsx("td",{children:a.days}),e.jsx("td",{children:a.overtime_hours||0}),e.jsx("td",{children:t((Number(a.amount)||0)+(Number(a.overtime_amount)||0))})]},a.id)),e.jsxs("tr",{children:[e.jsx("td",{colSpan:6,style:{textAlign:"right",fontWeight:"bold"},children:"Total Labour Cost"}),e.jsx("td",{style:{fontWeight:"bold"},children:t(b)})]})]})]}),e.jsxs("div",{className:"footer",children:[e.jsxs("div",{children:[i.email," · ",i.website]}),e.jsxs("div",{children:["Generated ",new Date().toLocaleDateString("en-IN")]})]})]})]})}export{w as default};
