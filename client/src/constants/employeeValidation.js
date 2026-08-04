// Client-side mirror of server/lib/employeeValidation.js's per-field FORMAT
// rules (Mandatory Field Spec). UX only — the server re-validates everything
// unconditionally on every POST/PUT and is the real authority. Catching these
// before the request fires saves a round trip and lets the Workspace point
// at the exact field instead of a generic "Failed" toast.
//
// Deliberately narrower than the server: enum fields (gender, blood group,
// employment type, confirmation status, notice period, grade) are already
// constrained to valid values by <select>/the fetched catalog, so there's
// nothing free-text to mis-type — only the genuinely free-text/typed fields
// below need a client-side format check.

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const PIN_RE = /^[0-9]{6}$/;

const ymd = (d) => d.toISOString().slice(0, 10);
const addYears = (base, years) => { const d = new Date(base); d.setFullYear(d.getFullYear() + years); return d; };

// Bounds also used directly as <input type="date"> min/max, so the picker
// itself can't offer an out-of-range date.
export const DOB_MAX = ymd(addYears(new Date(), -18));
export const JOIN_DATE_MIN = ymd(addYears(new Date(), -30));
export const JOIN_DATE_MAX = ymd(new Date());

// Indian addresses (flat/building, street, landmark, area, city, state, PIN
// all in one free-text block) routinely run 150-220 characters — 250 gives
// room without being an effectively-unbounded textarea.
export const ADDRESS_MAX_LEN = 250;

const norm = (v) => String(v || '').trim().toLowerCase();
const has = (form, k) => form[k] !== undefined && form[k] !== null && String(form[k]).trim() !== '';

// Returns [{ field, message }] for whatever is present in `form` — never
// checks presence itself (that's the Activation gate's job), only format,
// mirroring validateEmployee()'s contract so an edit to one field never
// blocks on another field being blank.
export function validateEmployeeClient(form) {
  const errors = [];
  const add = (field, message) => errors.push({ field, message });

  if (has(form, 'date_of_birth')) {
    const dob = String(form.date_of_birth).slice(0, 10);
    if (YMD_RE.test(dob) && dob > DOB_MAX) add('date_of_birth', 'Employee must be at least 18 years old');
  }
  if (has(form, 'join_date')) {
    const jd = String(form.join_date).slice(0, 10);
    if (YMD_RE.test(jd)) {
      if (jd > JOIN_DATE_MAX) add('join_date', 'Join date cannot be in the future');
      else if (jd < JOIN_DATE_MIN) add('join_date', 'Join date cannot be more than 30 years ago');
    }
  }
  if (has(form, 'permanent_pincode') && !PIN_RE.test(String(form.permanent_pincode).trim())) {
    add('permanent_pincode', 'PIN code must be 6 digits');
  }
  if (has(form, 'current_pincode') && !PIN_RE.test(String(form.current_pincode).trim())) {
    add('current_pincode', 'PIN code must be 6 digits');
  }
  if (has(form, 'emergency_contact_phone') && has(form, 'phone') && norm(form.emergency_contact_phone) === norm(form.phone)) {
    add('emergency_contact_phone', "Emergency contact cannot be the employee's own phone number");
  }
  if (has(form, 'emergency_contact_name') && has(form, 'name') && norm(form.emergency_contact_name) === norm(form.name)) {
    add('emergency_contact_name', 'Emergency contact cannot be the employee themselves');
  }
  if (has(form, 'permanent_address') && String(form.permanent_address).length > ADDRESS_MAX_LEN) {
    add('permanent_address', `Address is too long (max ${ADDRESS_MAX_LEN} characters)`);
  }
  if (has(form, 'current_address') && String(form.current_address).length > ADDRESS_MAX_LEN) {
    add('current_address', `Address is too long (max ${ADDRESS_MAX_LEN} characters)`);
  }
  return errors;
}
