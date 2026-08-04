import WasHint, { trackAccent } from '../WasHint';

// Phase 3 scope: only the fields that exist today (`name`). The remaining
// Personal fields from the HR pack (photo, DOB, gender, father/spouse name,
// blood group) land in Phase 4 — this section already has the right section
// key wired up (server/lib/employeeSections.js's `personal`), so pouring
// them in later is additive, not a restructure.
export default function PersonalSection({ ws }) {
  const { form, setForm, changedSet, original, revertField } = ws;
  return (
    <div className={trackAccent(changedSet, 'name')}>
      <label className="label">Name *</label>
      <input className="input" value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
      <WasHint k="name" changedSet={changedSet} original={original} revertField={revertField} />
    </div>
  );
}
