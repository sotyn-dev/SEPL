const f = (key,label,type='text',extra={}) => ({key,label,type,...extra});
const owner = f('owner_id','Owner','lookup',{lookup:'owner',required:true});
const client = f('customer_id','Company / Client','lookup',{lookup:'customer',required:true});
const vendor = f('vendor_id','Vendor company','lookup',{lookup:'vendor'});
const registration = f('registration_id','Vendor Registration','lookup',{lookup:'registration'});
const remarks = f('remarks','Remarks','textarea');
const platform = f('platform_id','TReDS Platform','lookup',{lookup:'platform',required:true});
const money = (key,label,required=false) => f(key,label,'money',{unit:'paise',required,min:0});
const definition = (table,label,permission,fields,statuses=[],transitions={},initialStatus=null) => ({
  table,label,permission,fields,statuses,transitions,initialStatus,
});

const ENTITY_DEFS = {
  registrations: definition('vt_registrations','Vendor Registration','vendor_registrations',[
    {...client,required:false},vendor,owner,f('registration_date','Registration Date','date',{required:true}),
    f('company_name','Company Name','text',{virtual:true,required:true}),f('website_url','Website URL','url',{virtual:true,required:true}),
    ...['sector','plant_location','city','state','contact_person','procurement_contact','phone','pan','gst_number','udyam'].map(key=>
      f(key,key.split('_').map(s=>s[0].toUpperCase()+s.slice(1)).join(' '),'text',{virtual:true})),
    f('turnover_amount','Turnover (₹)','number',{min:0,virtual:true}),f('address','Address','textarea',{virtual:true}),
    f('email','Email','email',{virtual:true}),
    f('source','Source','select',{options:['manual','chatgpt','gemini','referral','other']}),
    f('portal_url','Portal URL','url'),f('portal_login_id','Portal Login ID'),
    f('next_followup_at','Next Follow-up','datetime'),remarks,
  ],['not_started','started','submitted','docs_pending','approved','enquiry_received','quote_sent','po_received','invite_only','rejected'],{
    not_started:['started','invite_only','rejected'],started:['submitted','docs_pending','invite_only','rejected'],
    submitted:['docs_pending','approved','rejected'],docs_pending:['submitted','approved','rejected'],
    approved:['enquiry_received','rejected'],enquiry_received:['quote_sent','rejected'],
    quote_sent:['po_received','rejected'],po_received:[],invite_only:['started','rejected'],rejected:['started'],
  },'not_started'),
  documents: definition('vt_documents','Registration Documents','vendor_registrations',[
    {...registration,required:true},f('type_id','Document Type','lookup',{lookup:'document_type',required:true}),
    f('storage_key','File storage key','text',{required:true}),f('filename','Filename','text',{required:true}),
    f('mime','MIME type','text',{required:true}),f('size_bytes','File size','number',{required:true,min:1}),
    f('expiry_date','Expiry Date','date'),remarks,
  ],['uploaded','pending','verified','rejected','expired'],{
    uploaded:['pending','verified','rejected','expired'],pending:['uploaded','verified','rejected'],
    verified:['expired','rejected'],rejected:['uploaded'],expired:['uploaded'],
  },'uploaded'),
  approvals: definition('vt_approvals','Vendor Approvals','vendor_approvals',[
    {...registration,required:true},f('application_date','Application Date','date',{required:true}),
    f('vendor_code','Client Vendor Code'),f('approval_date','Approval Date','date'),
    f('valid_until','Valid Till','date'),f('document_id','Approval Document','lookup',{lookup:'document'}),owner,remarks,
  ],['pending','docs_pending','under_review','approved','rejected','expired'],{
    pending:['docs_pending','under_review','approved','rejected'],docs_pending:['under_review','approved','rejected'],
    under_review:['docs_pending','approved','rejected'],approved:['expired','rejected'],rejected:['pending'],expired:['under_review','approved'],
  },'pending'),
  contacts: definition('vt_contacts','Procurement / AP Contacts','vendor_treds_masters',[
    client,f('kind','Contact Type','select',{required:true,options:['general','procurement','ap']}),
    f('name','Contact Name','text',{required:true}),f('email','Email','email'),f('phone','Phone'),owner,remarks,
  ]),
  enquiries: definition('vt_enquiries','Enquiries / RFQs','vendor_enquiries',[
    {...registration,required:true},client,f('crm_funnel_id','Existing CRM Enquiry','lookup',{lookup:'crm_funnel'}),
    f('contact_id','Procurement Contact','lookup',{lookup:'contact'}),f('product_service','Product / Service'),
    f('enquiry_date','Enquiry Date','date',{required:true}),f('rfq_number','RFQ Number'),
    money('expected_amount_paise','Expected Value'),f('due_date','Due Date','date'),owner,
    f('is_mnc','MNC Enquiry','boolean'),f('next_followup_at','Next Follow-up','datetime'),remarks,
  ],['enquiry_received','rfq_received','quote_preparing','quote_sent','negotiation','po_received','lost','rejected','closed'],{
    enquiry_received:['rfq_received','quote_preparing','lost','rejected','closed'],
    rfq_received:['quote_preparing','lost','rejected','closed'],quote_preparing:['quote_sent','lost','rejected'],
    quote_sent:['negotiation','po_received','lost','rejected'],negotiation:['quote_sent','po_received','lost','rejected'],
    po_received:['closed'],lost:['closed'],rejected:['closed'],closed:[],
  },'enquiry_received'),
  accounts: definition('vt_accounts','TReDS Accounts','treds_accounts',[
    platform,vendor,f('registration_date','Registration Date','date'),
    f('account_status','Account Status','select',{options:['inactive','active','frozen']}),
    f('login_id','Username / Login ID'),f('last_verified_date','Last Verified Date','date'),owner,remarks,
  ],['not_started','registration_started','pending_verification','active','frozen','inactive'],{
    not_started:['registration_started'],registration_started:['pending_verification','inactive'],
    pending_verification:['active','inactive'],active:['frozen','inactive'],frozen:['active','inactive'],inactive:['registration_started','active'],
  },'not_started'),
  mappings: definition('vt_mappings','TReDS Client Mapping','treds_accounts',[
    client,platform,f('account_id','TReDS Account','lookup',{lookup:'account'}),
    f('contact_id','AP Contact','lookup',{lookup:'contact'}),
    f('turnover_over_250cr','Turnover > ₹250 Cr?','boolean',{nullable:true}),
    f('acceptance_confirmed','Acceptance Confirmed?','boolean',{nullable:true}),
    f('last_contact_at','Last Contact','datetime'),f('next_followup_at','Next Follow-up','datetime'),owner,remarks,
  ]),
  followups: definition('vt_followups','Follow-ups','vendor_enquiries',[
    f('enquiry_id','Enquiry / RFQ','lookup',{lookup:'enquiry'}),f('mapping_id','Client Platform Mapping','lookup',{lookup:'mapping'}),registration,
    owner,f('contact_at','Contact Date / Time','datetime'),f('next_followup_at','Next Follow-up','datetime'),
    f('notes','Follow-up Notes','textarea',{required:true}),f('reminder_at','Reminder','datetime'),
    f('completed_at','Completed At','datetime'),
  ]),
  invoices: definition('vt_invoices','Invoices','treds_invoices',[
    f('sales_bill_id','Existing ERP Invoice','lookup',{lookup:'sales_bill'}),client,vendor,registration,
    f('account_id','TReDS Account','lookup',{lookup:'account',required:true}),platform,
    f('external_invoice_number','Invoice Number','text',{required:true}),f('invoice_date','Invoice Date','date',{required:true}),
    f('due_date','Due Date','date'),money('amount_paise','Invoice Amount',true),f('po_number','PO Number'),owner,remarks,
  ],['uploaded','accepted','bid_received','funded','rejected','on_hold','cancelled'],{
    uploaded:['accepted','rejected','on_hold','cancelled'],accepted:['bid_received','rejected','on_hold','cancelled'],
    bid_received:['on_hold','rejected','cancelled'],funded:[],rejected:[],on_hold:['uploaded','accepted','bid_received','cancelled'],cancelled:[],
  },'uploaded'),
  funding: definition('vt_funding','Bill Discounting','bill_discounting',[
    f('invoice_id','Invoice','lookup',{lookup:'invoice',required:true}),money('principal_paise','Financed Principal'),
    f('discount_rate','Discount %','number',{min:0,max:100}),f('basis','Discount Basis','select',{options:['flat','annualized']}),
    f('term_days','Tenor (Days)','number',{min:0}),f('day_basis','Day Count Basis','select',{options:[365,360]}),
    money('discount_paise','Discount Amount'),money('fees_paise','Fees'),money('taxes_paise','Taxes'),
    {...money('expected_net_paise','Expected Net Proceeds'),readOnly:true},money('actual_received_paise','Actual Amount Received'),
    f('expected_settlement','Expected Settlement','date'),f('bank_reference','Bank Reference'),
    f('bank_transaction_id','Financier Bank Receipt','lookup',{lookup:'bank_transaction'}),
    f('receivable_id','Existing Receivable','lookup',{lookup:'receivable'}),f('collection_id','Accounting Receipt','lookup',{lookup:'collection'}),owner,remarks,
  ],['invoice_uploaded','client_accepted','bid_received','funding_approved','funded','reconciled','closed','on_hold','cancelled','rejected'],{
    invoice_uploaded:['client_accepted','on_hold','cancelled','rejected'],client_accepted:['bid_received','on_hold','cancelled','rejected'],
    bid_received:['funding_approved','on_hold','cancelled','rejected'],funding_approved:['funded','on_hold','cancelled','rejected'],
    funded:['reconciled'],reconciled:['closed'],closed:[],on_hold:['invoice_uploaded','client_accepted','bid_received','funding_approved','cancelled'],
    cancelled:[],rejected:[],
  },'invoice_uploaded'),
  catalog: definition('vt_catalog','Master Data','vendor_treds_masters',[
    f('kind','Master Type','select',{required:true,options:['platform','doc_type','sector','service']}),
    f('code','Code','text',{required:true}),f('label','Name','text',{required:true}),
    f('required','Required Document','boolean'),f('active','Active','boolean'),
  ]),
};

const STATUS_LABELS = {not_started:'Not Started',started:'Started',submitted:'Submitted',docs_pending:'Documents Pending',
  approved:'Approved',enquiry_received:'Enquiry Received',quote_sent:'Quote Sent',po_received:'PO Received',invite_only:'Invite-only',
  rejected:'Rejected',pending:'Pending',under_review:'Under Review',expired:'Expired',rfq_received:'RFQ Received',
  quote_preparing:'Quote Preparing',negotiation:'Negotiation',lost:'Lost',closed:'Closed',registration_started:'Registration Started',
  pending_verification:'Pending Verification',active:'Active',frozen:'Frozen',inactive:'Inactive',uploaded:'Uploaded',verified:'Verified',
  accepted:'Accepted by Client',bid_received:'Bid Received',funded:'Funded',on_hold:'On Hold',cancelled:'Cancelled',
  invoice_uploaded:'Invoice Uploaded',client_accepted:'Client Accepted',funding_approved:'Funding Approved',reconciled:'Payment Reconciled'};
const normalizeKind = kind => ({registration:'registrations',document:'documents',approval:'approvals',contact:'contacts',enquiry:'enquiries',
  account:'accounts',mapping:'mappings',followup:'followups',invoice:'invoices',bill_discounting:'funding',masters:'catalog'}[kind] || kind);
module.exports = { ENTITY_DEFS, STATUS_LABELS, normalizeKind };
