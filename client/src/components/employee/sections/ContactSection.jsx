import WasHint, { trackAccent } from '../WasHint';

// Phase 3 scope: phone, email — the existing 2 of this section's eventual 8
// (addresses + emergency contact arrive in Phase 4).
export default function ContactSection({ ws }) {
  const { form, setForm, changedSet, original, revertField } = ws;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div className={trackAccent(changedSet, 'phone')}>
        <label className="label">Phone</label>
        <input className="input" value={form.phone || ''} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        <WasHint k="phone" changedSet={changedSet} original={original} revertField={revertField} />
      </div>
      <div className={trackAccent(changedSet, 'email')}>
        <label className="label">Email</label>
        <input className="input" value={form.email || ''} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <WasHint k="email" changedSet={changedSet} original={original} revertField={revertField} />
      </div>
    </div>
  );
}
