import schema from '../../../../shared/employeeMaster.json';
export const sections = schema.sections;
export const fields = schema.fields;
export const currency = value => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(Number(value) || 0);
const present = v => v != null && String(v).trim() !== '';
export function fieldVisible(field, access) {
  return (field.section !== 'compensation' || access.salaryView) && (!field.sensitive || field.section === 'compensation' || access.privateView);
}
export function completion(form, files, access) {
  return Object.fromEntries(sections.map(section => {
    const needed = fields.filter(f => f.section === section.id && f.completionRequired && fieldVisible(f, access));
    const missing = needed.filter(f => !present(form[f.key]) && !files[f.key]).map(f => f.label);
    let total = needed.length;
    if (section.id === 'basic') { total++; if (!present(form.phone) && !present(form.email)) missing.push('Phone or email'); }
    return [section.id, { total, done: total - missing.length, missing }];
  }));
}
export function changedPayload(form, baseline, access) {
  const payload = {};
  for (const f of fields) {
    if (!f.editableByHR || !fieldVisible(f, access) || (f.section === 'compensation' && !access.salaryEdit)) continue;
    if (JSON.stringify(form[f.key] ?? '') !== JSON.stringify(baseline[f.key] ?? '')) payload[f.key] = form[f.key] === '' ? null : form[f.key];
  }
  return payload;
}
export function validateForm(form, keys, quick) {
  const errors = {};
  const selected = new Set(keys);
  const error = (key, condition, message) => { if (selected.has(key) && condition) errors[key] = message; };
  for (const f of fields) {
    error(f.key, (quick ? f.requiredOnQuickCreate : f.required) && !present(form[f.key]), `${f.label} is required`);
    if (present(form[f.key]) && f.type === 'money') error(f.key, !Number.isFinite(Number(form[f.key])) || Number(form[f.key]) < 0, 'Enter an amount of zero or greater');
  }
  if (quick && !present(form.phone) && !present(form.email)) errors.phone = 'Enter a phone number or email address';
  for (const key of ['phone','emergency_contact_phone']) error(key, present(form[key]) && !/^(?:91)?[6-9]\d{9}$/.test(String(form[key]).replace(/\D/g, '')), 'Enter a 10-digit Indian mobile number, optionally with +91');
  error('email', present(form.email) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email), 'Enter a valid email address');
  for (const key of ['permanent_pin','current_pin']) error(key, present(form[key]) && !/^[1-9]\d{5}$/.test(form[key]), 'PIN must be six digits and cannot start with zero');
  error('pan_number', present(form.pan_number) && !/^[A-Z]{5}\d{4}[A-Z]$/.test(form.pan_number), 'PAN must be five letters, four digits and one letter');
  error('aadhaar_last4', present(form.aadhaar_last4) && !/^\d{4}$/.test(form.aadhaar_last4), 'Enter the last four digits only');
  error('uan_number', present(form.uan_number) && !/^\d{12}$/.test(form.uan_number), 'UAN must contain 12 digits');
  error('bank_ifsc', present(form.bank_ifsc) && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(form.bank_ifsc), 'Enter a valid IFSC code');
  error('bank_account_no', present(form.bank_account_no) && !/^\d{6,20}$/.test(form.bank_account_no), 'Account number must contain 6–20 digits');
  error('bonus_target_pct', present(form.bonus_target_pct) && (!Number.isFinite(Number(form.bonus_target_pct)) || Number(form.bonus_target_pct) < 0 || Number(form.bonus_target_pct) > 100), 'Enter a percentage from 0 to 100');
  error('probation_end_date', form.probation_end_date && form.join_date && form.probation_end_date < form.join_date, 'Probation cannot end before the joining date');
  if (form.date_of_birth && selected.has('date_of_birth')) {
    const now = new Date(Date.now() + 19800000);
    const cutoff = new Date(Date.UTC(now.getUTCFullYear() - 18, now.getUTCMonth(), now.getUTCDate())).toISOString().slice(0,10);
    error('date_of_birth', form.date_of_birth > cutoff || form.date_of_birth < '1940-01-01', 'Employee must be at least 18; check the birth date');
  }
  return errors;
}
