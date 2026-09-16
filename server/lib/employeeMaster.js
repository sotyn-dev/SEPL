const schema = require('../../shared/employeeMaster.json');
const { SALARY_FIELDS } = require('./employeeTerms');
const DOCUMENT_FIELDS = schema.fields.filter(f => f.type === 'file').map(f => f.key);
const PRIVATE_FIELDS = schema.fields.filter(f => f.sensitive && f.section !== 'compensation').map(f => f.key);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const present = value => value !== null && value !== undefined && String(value).trim() !== '';

function access(req, permissions) {
  const admin = req.user.role === 'admin';
  return {
    privateView: admin || !!permissions.employees?.can_view,
    salaryView: admin || !!permissions.employee_salary?.can_view,
    salaryEdit: admin || !!(permissions.employee_salary?.can_view && permissions.employee_salary?.can_edit),
  };
}
function redact(row, permissions) {
  const safe = { ...row };
  if (!permissions.salaryView) for (const key of ['salary', ...SALARY_FIELDS]) delete safe[key];
  if (!permissions.privateView) for (const key of PRIVATE_FIELDS) delete safe[key];
  return safe;
}
function completion(row, permissions) {
  const sections = {};
  for (const section of schema.sections) {
    const fields = schema.fields.filter(f => f.section === section.id && f.completionRequired &&
      (permissions.salaryView || f.section !== 'compensation') && (permissions.privateView || !f.sensitive || f.section === 'compensation'));
    const required = fields.map(f => f.key);
    if (section.id === 'basic') required.push('contact');
    const missing = required.filter(key => key === 'contact' ? !present(row.phone) && !present(row.email) : !present(row[key]));
    sections[section.id] = { total: required.length, completed: required.length - missing.length, missing };
  }
  const total = Object.values(sections).reduce((n, s) => n + s.total, 0);
  const completed = Object.values(sections).reduce((n, s) => n + s.completed, 0);
  return { sections, total, completed, percent: total ? Math.round(completed / total * 100) : 0 };
}
function validateInput(body, previous, permissions, hasEmployees = true) {
  const errors = {};
  if (!permissions.salaryEdit) {
    for (const key of ['salary', ...SALARY_FIELDS]) {
      if (has(body, key) && key !== 'ctc_annual' && String(body[key] ?? '') !== String(previous?.[key] ?? '')) errors[key] = 'Salary edit permission is required';
    }
  }
  if (!permissions.privateView) for (const key of PRIVATE_FIELDS) {
    if (has(body, key) && String(body[key] ?? '') !== String(previous?.[key] ?? '')) errors[key] = 'Employee view permission is required for private information';
  }
  if (has(body, 'name') && !String(body.name || '').trim()) errors.name = 'Enter the employee name';
  for (const f of schema.fields) {
    if (!has(body, f.key) || !present(body[f.key])) continue;
    const value = body[f.key];
    if (['text', 'tel', 'email', 'suggestion', 'textarea'].includes(f.type) && (typeof value !== 'string' || value.length > (f.type === 'textarea' ? 2000 : 200))) errors[f.key] = 'Enter a valid value';
    if (f.type === 'select' && !f.options.some(([key]) => String(key) === String(value))) errors[f.key] = `Select a valid ${f.label.toLowerCase()}`;
    if (f.type === 'file' && (typeof value !== 'string' || !/^\/uploads\/[^?#]+\.(pdf|jpe?g|png)$/i.test(value) || value.includes('..'))) errors[f.key] = 'Choose an uploaded PDF, JPG or PNG';
  }
  if (has(body, 'email') && present(body.email) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) errors.email = 'Enter a valid email address';
  for (const key of ['phone','emergency_contact_phone']) {
    if (has(body,key) && present(body[key])) {
      const digits = String(body[key]).replace(/\D/g,'');
      if (!/^(?:91)?[6-9]\d{9}$/.test(digits)) errors[key] = 'Enter a 10-digit Indian mobile number, optionally with +91';
    }
  }
  const merged = { ...previous, ...body };
  if (['phone','emergency_contact_phone'].some(k => has(body,k)) && present(merged.phone) && present(merged.emergency_contact_phone) &&
      String(merged.phone).replace(/\D/g,'').slice(-10) === String(merged.emergency_contact_phone).replace(/\D/g,'').slice(-10)) errors.emergency_contact_phone = 'Emergency contact cannot be your own number';
  if (body.quick_onboarding === true) {
    for (const f of schema.fields.filter(f => f.requiredOnQuickCreate && (f.key !== 'reports_to' || hasEmployees))) if (!present(body[f.key])) errors[f.key] = `${f.label} is required to start onboarding`;
    if (!present(body.phone) && !present(body.email)) errors.phone = 'Enter a phone number or email address';
  }
  return errors;
}
module.exports = { schema, DOCUMENT_FIELDS, PRIVATE_FIELDS, access, redact, completion, validateInput };
