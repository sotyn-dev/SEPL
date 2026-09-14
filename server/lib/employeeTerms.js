const FIELDS = ['reports_to', 'employment_type', 'employment_status', 'notice_period_days', 'probation_end_date', 'uan_number', 'uan_verified', 'permanent_address', 'permanent_pin', 'current_address', 'current_pin', 'same_as_permanent', 'pf_number', 'esi_number', 'pt_state', 'form11_file', 'form_f_file', 'ctc_annual', 'variable_bonus', 'basic_salary', 'hra', 'pf_deduction', 'esi_deduction', 'blood_group', 'tds_estimated_annual', 'last_increment_date'];
function employeeTerms(body, db, employeeId) {
  const values = {};
  for (const field of FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
    const raw = body[field];
    values[field] = raw === '' || raw == null ? null : raw;
  }
  for (const [field, choices] of Object.entries({ employment_type: ['permanent', 'contract', 'intern'], employment_status: ['probation', 'confirmed'] })) {
    if (values[field] != null && !choices.includes(values[field])) throw new Error(`Invalid ${field.replaceAll('_', ' ')}`);
  }
  if (values.notice_period_days != null) {
    values.notice_period_days = Number(values.notice_period_days);
    if (![30, 60, 90].includes(values.notice_period_days)) throw new Error('Notice period must be 30, 60 or 90 days');
  }
  if (values.reports_to != null) {
    values.reports_to = Number(values.reports_to);
    if (!Number.isSafeInteger(values.reports_to) || values.reports_to <= 0) throw new Error('Select a valid manager');
    if (values.reports_to === Number(employeeId)) throw new Error('An employee cannot report to themselves');
    if (!db.prepare('SELECT id FROM employees WHERE id=?').get(values.reports_to)) throw new Error('Manager does not exist');
  }
  if (values.probation_end_date != null) {
    const date = values.probation_end_date;
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new Error('Enter a valid probation end date');
    const join = body.join_date || (employeeId ? db.prepare('SELECT join_date FROM employees WHERE id=?').get(employeeId)?.join_date : null);
    if (join && date < join) throw new Error('Probation end date cannot be before join date');
  }
  if (values.uan_number != null && (typeof values.uan_number !== 'string' || !/^\d{12}$/.test(values.uan_number))) throw new Error('UAN must contain exactly 12 digits');
  if ('uan_verified' in values && ![0, 1, true, false].includes(values.uan_verified)) throw new Error('Invalid UAN verification');
  if ('uan_number' in values || 'uan_verified' in values) {
    const current = employeeId ? db.prepare('SELECT uan_number, uan_verified FROM employees WHERE id=?').get(employeeId) : null;
    const uan = 'uan_number' in values ? values.uan_number : current?.uan_number;
    if (values.uan_verified && !uan) throw new Error('Enter a UAN before marking it verified');
    // Replacing a previously verified number always requires a separate review.
    if (!uan || (current?.uan_number && 'uan_number' in values && values.uan_number !== current.uan_number)) values.uan_verified = 0;
    else if ('uan_verified' in values) values.uan_verified = values.uan_verified ? 1 : 0;
  }
  for (const key of ["ctc_annual","variable_bonus","basic_salary","hra","pf_deduction","esi_deduction","tds_estimated_annual"]) {
    if (values[key] != null) {
      if (!['number', 'string'].includes(typeof values[key])) throw new Error('Enter a valid amount');
      values[key] = Number(values[key]);
      if (!Number.isFinite(values[key]) || values[key] < 0) throw new Error('Amounts must be zero or greater');
    }
  }
  for (const key of ['permanent_address', 'current_address', 'pf_number', 'esi_number', 'pt_state', 'form11_file', 'form_f_file']) {
    if (values[key] != null && (typeof values[key] !== 'string' || values[key].length > 2000)) throw new Error('Invalid ' + key.replaceAll('_', ' '));
  }
  for (const key of ['permanent_pin', 'current_pin']) {
    if (values[key] != null && (typeof values[key] !== 'string' || !/^[1-9][0-9]{5}$/.test(values[key]))) throw new Error('PIN code must be 6 digits and cannot start with zero');
  }
  for (const key of ['form11_file', 'form_f_file']) {
    if (values[key] && !values[key].startsWith('/uploads/')) throw new Error('Use an uploaded document');
  }
  if ('same_as_permanent' in values && ![0, 1, true, false].includes(values.same_as_permanent)) throw new Error('Invalid address selection');
  const addressFields = ['permanent_address','permanent_pin','current_address','current_pin','same_as_permanent'];
  if (addressFields.some(key => key in values)) {
    const previous = employeeId ? db.prepare('SELECT permanent_address, permanent_pin, same_as_permanent FROM employees WHERE id=?').get(employeeId) : null;
    const same = 'same_as_permanent' in values ? !!values.same_as_permanent : !!previous?.same_as_permanent;
    if ('same_as_permanent' in values) values.same_as_permanent = same ? 1 : 0;
    if (same) {
      values.current_address = 'permanent_address' in values ? values.permanent_address : previous?.permanent_address ?? null;
      values.current_pin = 'permanent_pin' in values ? values.permanent_pin : previous?.permanent_pin ?? null;
    }
  }
  if (values.blood_group != null && !['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].includes(values.blood_group)) throw new Error('Select a valid blood group');
  if (values.last_increment_date != null) {
    const date = values.last_increment_date;
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new Error('Enter a valid last increment date');
  }
  return values;
}
module.exports = { employeeTerms };
