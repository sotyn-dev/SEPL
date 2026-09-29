import { STAFF_TYPES } from '../utils/staffType';

export default function StaffTypeFilter({ value, onChange }) {
  return (
    <select className="select w-full sm:w-48 text-sm" aria-label="Filter by staff type" value={value} onChange={e => onChange(e.target.value)}>
      <option value="">All staff types</option>
      {Object.entries(STAFF_TYPES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      <option value="unspecified">Not specified</option>
    </select>
  );
}
