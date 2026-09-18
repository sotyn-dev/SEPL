import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FiX, FiCheck, FiUser } from 'react-icons/fi';
import api from '../../api';
import { useAuth } from '../../context/AuthContext';
import SearchableSelect from '../SearchableSelect';
import EmployeeProfessionalTax from '../EmployeeProfessionalTax';
import DocumentUpload from './DocumentUpload';
import EmployeeAssets from './EmployeeAssets';
import { sections, fields, completion, changedPayload, validateForm, fieldVisible, currency } from './employeeForm';
import { STATES } from '../../data/indiaLocations';
import { probationEndDate } from '../../utils/probation';
import './employeeMaster.css';

export default function EmployeeMaster({ employee, employees, users, onClose, onSaved }) {
  const auth = useAuth();
  const access = { privateView: auth.isAdmin() || auth.canView('employees'), salaryView: auth.isAdmin() || auth.canView('employee_salary'), salaryEdit: auth.isAdmin() || (auth.canView('employee_salary') && auth.canEdit('employee_salary')) };
  const [baseline, setBaseline] = useState(employee || { status: 'active', roster: 'general' });
  const [form, setForm] = useState(employee || { status: 'active', roster: 'general' });
  const [files, setFiles] = useState({});
  const [section, setSection] = useState('basic');
  const [errors, setErrors] = useState({});
  const [status, setStatus] = useState('');
  const [loginDetails, setLoginDetails] = useState(null);
  const [saving, setSaving] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [options, setOptions] = useState({ equipment: [], vehicles: [], scorecards: [] });
  const [loading, setLoading] = useState(true);
  const [optionsError, setOptionsError] = useState('');
  const [ifscStatus, setIfscStatus] = useState('');
  const dialog = useRef(null);
  const content = useRef(null);
  const quick = !baseline.id;
  const editable = auth.isAdmin() || (quick ? auth.canCreate('employees') : auth.canEdit('employees'));
  const changes = changedPayload(form, baseline, access);
  const dirty = Object.keys(changes).length > 0 || Object.keys(files).length > 0;
  const stateRef = useRef({});
  stateRef.current = { dirty, saving, onClose };
  const loadOptions = () => {
    setLoading(true); setOptionsError('');
    api.get('/hr/employee-options').then(r => setOptions(r.data)).catch(() => setOptionsError('Asset and scorecard data could not be loaded.')).finally(() => setLoading(false));
  };
  useEffect(() => {
    let active = true;
    api.get('/hr/employee-options').then(r => { if (active) setOptions(r.data); }).catch(() => { if (active) setOptionsError('Asset and scorecard data could not be loaded.'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    const previousFocus = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const appRoot = document.getElementById('root');
    const wasInert = appRoot?.inert;
    if (appRoot) appRoot.inert = true;
    dialog.current?.focus();
    const leave = e => { if (stateRef.current.dirty) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', leave);
    const startIndex = window.history.state?.idx;
    const historyLeave = event => {
      const nextIndex = event.state?.idx;
      if (stateRef.current.dirty && Number.isInteger(startIndex) && Number.isInteger(nextIndex) && startIndex !== nextIndex && !window.confirm('Leave the employee editor and discard unsaved changes?')) {
        event.stopImmediatePropagation();
        window.history.go(startIndex - nextIndex);
      }
    };
    window.addEventListener('popstate', historyLeave, true);
    return () => { if (appRoot) appRoot.inert = wasInert; document.body.style.overflow = overflow; window.removeEventListener('beforeunload', leave); window.removeEventListener('popstate', historyLeave, true); previousFocus?.focus(); };
  }, []);
  const close = () => { if (saving) return; if (dirty) setDiscard(true); else onClose(); };
  const navigate = id => { setSection(id); content.current?.scrollTo(0, 0); };
  const change = (key, value) => {
    setStatus(''); setErrors(old => ({ ...old, [key]: undefined }));
    setForm(old => {
      const next = { ...old, [key]: value };
      if (key === 'uan_number') next.uan_verified = 0;
      if (key === 'user_id') { delete next.equipment_asset_ids; delete next.vehicle_asset_id; }
      if (next.same_as_permanent) { next.current_address = next.permanent_address || ''; next.current_pin = next.permanent_pin || ''; }
      return next;
    });
  };
  const lookupIfsc = async code => {
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(code || '')) return;
    setIfscStatus('Looking up bank and branch…');
    try {
      const { data } = await api.get(`/hr/ifsc/${code}`);
      setForm(old => old.bank_ifsc === code ? { ...old, bank_name: data.bank || old.bank_name, bank_branch: data.branch || old.bank_branch } : old);
      setIfscStatus('Bank details retrieved. Please verify before saving.');
    } catch { setIfscStatus('Lookup unavailable. Enter bank and branch manually.'); }
  };
  const showErrors = next => {
    setErrors(next);
    const first = fields.find(f => next[f.key]);
    if (first && !quick) navigate(first.section);
    setTimeout(() => document.getElementById(`em-${first?.key}`)?.focus(), 0);
  };
  const save = async event => {
    event.preventDefault();
    if (!editable || saving) return;
    const payload = quick ? { ...form, quick_onboarding: true } : { ...changes };
    const invalid = validateForm(form, quick ? fields.filter(f => f.quickCreate && (f.key !== 'reports_to' || employees.length)).map(f => f.key) : Object.keys(payload), quick);
    if (Object.keys(invalid).length) { showErrors(invalid); return; }
    setSaving(true); setStatus('Saving…'); setErrors({});
    try {
      for (const [key, file] of Object.entries(files)) {
        const fd = new FormData(); fd.append('file', file);
        const { data } = await api.post('/upload?purpose=employee-document', fd);
        if (!data.url) throw new Error('Document upload returned no file URL');
        payload[key] = data.url;
        setForm(old => ({ ...old, [key]: data.url }));
        setFiles(old => { const next = { ...old }; delete next[key]; return next; });
      }
      const { data } = quick ? await api.post('/hr/employees', payload) : await api.put(`/hr/employees/${baseline.id}`, payload);
      const saved = data.employee || { ...form, ...payload, id: data.id || baseline.id };
      setBaseline(saved); setForm(saved); setFiles({});
      if (quick && data.login_details) { setLoginDetails(data.login_details); setSection('employment'); }
      setStatus(quick ? 'Employee created. Continue onboarding below.' : 'All changes saved');
      onSaved(); loadOptions();
    } catch (error) {
      const next = error.response?.data?.fields;
      if (next && typeof next === 'object') showErrors(next);
      setStatus(`Error: ${error.response?.data?.error || error.message || 'Could not save. Your changes are retained.'}`);
    } finally { setSaving(false); }
  };
  const progress = completion(form, files, access);
  const total = Object.values(progress).reduce((sum, s) => sum + s.total, 0);
  const done = Object.values(progress).reduce((sum, s) => sum + s.done, 0);
  const percent = total ? Math.round(done / total * 100) : 0;
  const visibleSections = sections.filter(s => s.id !== 'compensation' || access.salaryView);
  const current = sections.find(s => s.id === section);
  const scorecard = options.scorecards?.find(s => Number(s.user_id) === Number(form.user_id));
  const renderField = field => {
    const { key, label, type } = field;
    const disabled = saving || !editable || (field.section === 'compensation' && !access.salaryEdit) || (['current_address','current_pin'].includes(key) && !!form.same_as_permanent);
    const required = quick ? field.requiredOnQuickCreate && (key !== 'reports_to' || employees.length > 0) : field.required;
    const common = { id: `em-${key}`, className: `input ${errors[key] ? 'em-invalid' : ''}`, disabled, value: form[key] ?? '', 'aria-invalid': !!errors[key], 'aria-describedby': errors[key] ? `em-error-${key}` : undefined, onChange: e => change(key, ['pan_number','bank_ifsc'].includes(key) ? e.target.value.toUpperCase() : e.target.value) };
    let input;
    if (type === 'assets') return null;
    if (type === 'file') return <DocumentUpload key={key} field={field} value={form[key]} file={files[key]} disabled={disabled} error={errors[key]} onFile={file => { setFiles(old => ({ ...old, [key]: file })); setStatus(''); }} onRemove={() => { setFiles(old => { const next = { ...old }; delete next[key]; return next; }); change(key, null); }} />;
    if (type === 'system' || type === 'calculated') return <div key={key} className="em-calculated"><span>{label}</span><strong>{type === 'system' ? form[key] || 'Assigned on creation' : currency(Number(form.salary || 0) * 12)}</strong><small>{type === 'calculated' ? 'Auto calculated · Monthly salary × 12' : 'System managed'}</small></div>;
    if (type === 'pt') return <EmployeeProfessionalTax key={key} state={form.pt_state} salary={form.salary} />;
    if (type === 'checkbox') return <div key={key} className="em-full"><label className="em-check"><input id={`em-${key}`} type="checkbox" checked={!!form[key]} disabled={disabled || (key === 'uan_verified' && !/^\d{12}$/.test(form.uan_number || ''))} onChange={e => change(key, e.target.checked ? 1 : 0)} />{label}</label>{key === 'uan_verified' && <small>Mark only after checking supporting records. No automatic EPFO verification.</small>}</div>;
    if (type === 'manager' || type === 'user') {
      const source = type === 'manager' ? employees.filter(e => e.id !== baseline.id) : users;
      const items = source.map(item => ({ id: item.id, label: `${item.name || item.username}${item.designation ? ` · ${item.designation}` : ''}${item.email ? ` · ${item.email}` : ''}` }));
      if (form[key] && !items.some(i => i.id === Number(form[key]))) items.push({ id: Number(form[key]), label: `Current linked record #${form[key]}` });
      input = <SearchableSelect id={`em-${key}`} ariaLabel={label} disabled={disabled} options={items} value={Number(form[key]) || null} valueKey="id" placeholder={`Search ${type === 'manager' ? 'employees' : 'login users'}…`} onChange={item => change(key, item?.id ?? null)} />;
    } else if (type === 'select' || type === 'state') input = <select {...common}><option value="">Select…</option>{(type === 'state' ? STATES.map(s => [s,s]) : field.options).map(([value,text]) => <option key={value} value={value}>{text}</option>)}</select>;
    else if (type === 'textarea') input = <textarea {...common} rows={3} />;
    else if (type === 'probation') input = <><div className="em-segments">{[3,6].map(months => <button type="button" key={months} disabled={disabled || !form.join_date} onClick={() => change(key, probationEndDate(form.join_date, months))}>{months} months</button>)}</div><input {...common} type="date" /><small>Calculate from joining date or adjust manually.</small></>;
    else input = <><input {...common} type={['money','number'].includes(type) ? 'number' : ['date','email','tel'].includes(type) ? type : 'text'} min={['money','number'].includes(type) ? '0' : undefined} step={type === 'money' ? '0.01' : undefined} list={type === 'suggestion' ? `em-list-${key}` : undefined} onBlur={key === 'bank_ifsc' ? () => lookupIfsc(form.bank_ifsc) : undefined} />{type === 'suggestion' && <datalist id={`em-list-${key}`}>{[...new Set(employees.map(e => e[key]).filter(Boolean))].map(value => <option key={value} value={value} />)}</datalist>}{type === 'money' && form[key] !== '' && form[key] != null && <small>{currency(form[key])}</small>}</>;
    return <div key={key}><label htmlFor={`em-${key}`}>{label}{required && <span className="em-required"> *</span>}</label>{input}{key === 'bank_ifsc' && <small aria-live="polite">{ifscStatus || 'Bank and branch are filled from IFSC; manual entry remains available.'}</small>}{key === 'reports_to' && !employees.length && <small>No existing employees to select. Assign a manager after your first employee is created.</small>}{key === 'user_id' && <small>Links DPR staff costs and asset custody. A login is created automatically for new employees. Matching email links the existing account without changing its password.</small>}{key === 'aadhaar_last4' && <small>Only the last four digits are stored.</small>}{key === 'bonus_target_pct' && <small>{loading ? 'Loading scorecard…' : optionsError || `Linked scorecard: ${scorecard?.name || scorecard?.title || 'Not assigned'}`}. Target only; does not trigger payment.</small>}{errors[key] && <p id={`em-error-${key}`} className="em-error">{errors[key]}</p>}</div>;
  };
  return createPortal(<div className="em-overlay" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
    <div ref={dialog} className="em-dialog" role="dialog" aria-modal="true" aria-labelledby="em-title" tabIndex={-1} onKeyDown={e => {
      if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); if (discard) setDiscard(false); else close(); }
      if (e.key === 'Tab') { const scope = discard ? dialog.current.querySelector('.em-discard') : dialog.current; const nodes = [...scope.querySelectorAll('button:not(:disabled),input:not(:disabled):not([tabindex="-1"]),select:not(:disabled),textarea:not(:disabled),a[href]')].filter(n => n.getClientRects().length); const first = nodes[0], last = nodes.at(-1); if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { e.preventDefault(); last?.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); } }
    }}>
      <header className="em-header"><div className="em-avatar"><FiUser /></div><div className="em-heading"><p>HRMS / EMPLOYEE MASTER</p><h2 id="em-title">{quick ? 'Add employee' : form.name || 'Employee profile'}</h2><span>{quick ? 'Create the record, then complete onboarding.' : `${form.designation || 'Designation pending'} · ${form.department || 'Department pending'} · ID ${baseline.id}`}</span></div><button type="button" className="em-close" aria-label="Close employee editor" onClick={close} disabled={saving}><FiX size={22} /></button></header>
      {loginDetails && <div className="px-7 py-3 bg-emerald-50 text-xs text-emerald-900" role="status"><strong>{loginDetails.created ? 'Login created and linked' : 'Existing login linked'}</strong><span className="ml-3">Username: <code>{loginDetails.username || 'Use existing login'}</code></span>{loginDetails.created && <><span className="ml-3">Initial password: <code>123456</code></span><p className="mt-1">The employee must change this password at first login. These initial credentials are shown only after creation.</p></>}</div>}
      {!quick && <div className="em-progress"><span>Profile completion <b>{percent}%</b>{dirty && <small> · including unsaved changes</small>}</span><div><i style={{ width: `${percent}%` }} /></div><small>Required onboarding information; optional compliance and assets excluded.</small></div>}
      <form onSubmit={save} noValidate className="em-form">
        <div className={`em-body ${quick ? 'em-quick' : ''}`}>
          {!quick && <><nav className="em-nav" aria-label="Employee sections">{visibleSections.map(s => <button type="button" key={s.id} aria-current={section === s.id ? 'step' : undefined} onClick={() => navigate(s.id)}><span>{s.label}{fields.some(f => f.section === s.id && (Object.hasOwn(changes,f.key) || files[f.key])) && <i title="Unsaved changes" />}</span><small>{progress[s.id].total ? `${progress[s.id].done}/${progress[s.id].total}` : 'Optional'}</small></button>)}</nav><label className="em-mobile-nav">Section<select value={section} onChange={e => navigate(e.target.value)}>{visibleSections.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label></>}
          <main className="em-content" ref={content}>
            <div className="em-section-heading"><span>{quick ? 'START ONBOARDING' : current.ownership}</span><h3>{quick ? 'Employee essentials' : current.label}</h3><p>{quick ? 'Add organizational details and at least one contact method. Documents, bank and payroll details can follow. Login username is generated from the name (first.last); initial password: 123456.' : current.description}</p></div>
            {Object.values(errors).some(Boolean) && <div role="alert" className="em-error-box">Please check the highlighted fields.{Object.entries(errors).filter(([,v]) => v).map(([key,message]) => <button type="button" key={key} onClick={() => { const f = fields.find(f => f.key === key); if (f && !quick) navigate(f.section); setTimeout(() => document.getElementById(`em-${key}`)?.focus(),0); }}>{message}</button>)}</div>}
            <div className="em-grid">{fields.filter(f => (quick ? f.quickCreate : f.section === section) && fieldVisible(f,access)).map(renderField)}</div>
            {!quick && section === 'assets' && <EmployeeAssets form={form} change={change} options={options} disabled={!editable || saving || !(auth.isAdmin() || auth.canEdit('company_assets'))} loading={loading} error={optionsError} retry={loadOptions} />}
            {!quick && section === 'compensation' && <p className="em-footnote">LTA, medical and phone amounts are annual entitlement limits. Claims and payments are recorded separately.</p>}
          </main>
        </div>
        <footer className="em-footer"><div role="status" className={status.startsWith('Error:') ? 'em-error' : ''}>{status || (dirty ? 'Unsaved changes' : 'No unsaved changes')}{status === 'All changes saved' && <FiCheck />}</div><button type="button" className="btn btn-secondary" onClick={close} disabled={saving}>Close</button>{editable && <button type="submit" className="btn btn-primary" disabled={saving || (!quick && !dirty)}>{saving ? 'Saving…' : quick ? 'Create employee' : 'Save all changes'}</button>}</footer>
      </form>
      {discard && <div className="em-discard" role="alertdialog" aria-modal="true" aria-labelledby="em-discard-title"><div><h3 id="em-discard-title">Discard unsaved changes?</h3><p>Your changes have not been saved.</p><button type="button" className="btn btn-secondary" autoFocus onClick={() => setDiscard(false)}>Keep editing</button><button type="button" className="btn btn-primary" onClick={onClose}>Discard changes</button></div></div>}
    </div>
  </div>, document.body);
}
