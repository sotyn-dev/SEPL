// Single source of truth for "which Workspace section does this field belong
// to" (plan: keep-confirmation-status-separate-elegant-beacon, 2026-08-04
// section-level-saves revision).
//
// Deliberately separate from employeeFields.js — that module is about the
// change-history registry (tracked/snapshot/changeField); this one is about
// screen layout, and covers fields History never touches (blood_group,
// addresses, ...) plus the doc-upload fields, which aren't in the
// change-history registry at all.
//
// Consumers:
//   - employeeValidation.js's REQUIRED_FOR_ACTIVATION looks up each field's
//     section from here instead of hardcoding it a second time.
//   - GET /hr/employees/meta/sections returns SECTIONS verbatim — the
//     Workspace fetches it once and uses it to slice `form` state into each
//     section's own save payload. No client-side copy of this list exists.

const SECTIONS = {
  personal: [
    'photo_url', 'name', 'date_of_birth', 'gender', 'father_spouse_name', 'blood_group',
  ],
  employment: [
    'designation', 'department', 'reports_to_employee_id', 'grade',
    'employment_type', 'join_date', 'probation_end_date', 'confirmation_status',
    'notice_period_days', 'salary', 'roster', 'status',
  ],
  contact: [
    'phone', 'email', 'permanent_address', 'permanent_pincode',
    'current_address', 'current_pincode',
    'emergency_contact_name', 'emergency_contact_phone',
  ],
  documents: [
    'aadhar_file', 'aadhar_number', 'pan_file', 'pan_number', 'qualification_file',
  ],
  // The linked ERP login is a system relationship, not a fact ABOUT the
  // employee the way every other field is — it grants access and drives
  // payroll's DPR staff-cost calc. Kept as its own one-field section
  // (2026-08-04) so the Workspace can surface it in the header, always
  // visible regardless of which tab is open, rather than buried inside
  // Docs where it used to sit as an afterthought next to KYC uploads.
  access: [
    'user_id',
  ],
};

const SECTION_BY_FIELD = new Map(
  Object.entries(SECTIONS).flatMap(([section, keys]) => keys.map((k) => [k, section]))
);

module.exports = { SECTIONS, SECTION_BY_FIELD };
