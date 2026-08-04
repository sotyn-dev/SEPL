import WasHint, { FieldError, trackAccent } from '../WasHint';
import { ADDRESS_MAX_LEN } from '../../../constants/employeeValidation';

export default function ContactSection({ ws }) {
  const { form, setForm, changedSet, original, revertField } = ws;
  return (
    <div className="space-y-4">
      <div>
        <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">Reach</div>
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
      </div>

      <div className="border-t border-dashed pt-4 !mt-6">
        <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">Permanent Address</div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className={`sm:col-span-2 ${trackAccent(changedSet, 'permanent_address')}`}>
            <label className="label">Address</label>
            <textarea className="input" rows={2} maxLength={ADDRESS_MAX_LEN} value={form.permanent_address || ''} onChange={(e) => setForm({ ...form, permanent_address: e.target.value.slice(0, ADDRESS_MAX_LEN) })} />
            <div className="flex items-center justify-between">
              <WasHint k="permanent_address" changedSet={changedSet} original={original} revertField={revertField} />
              <span className="text-[10px] text-gray-400 mt-0.5 ml-auto shrink-0">{(form.permanent_address || '').length}/{ADDRESS_MAX_LEN}</span>
            </div>
            <FieldError k="permanent_address" ws={ws} />
          </div>
          <div className={trackAccent(changedSet, 'permanent_pincode')}>
            <label className="label">PIN Code</label>
            <input className="input" maxLength={6} value={form.permanent_pincode || ''} onChange={(e) => setForm({ ...form, permanent_pincode: e.target.value.replace(/\D/g, '').slice(0, 6) })} />
            <WasHint k="permanent_pincode" changedSet={changedSet} original={original} revertField={revertField} />
            <FieldError k="permanent_pincode" ws={ws} />
          </div>
        </div>
      </div>

      <div className="border-t border-dashed pt-4 !mt-6">
        <div className="flex items-center justify-between mb-2">
          <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide">Current Address</div>
          <button
            type="button"
            onClick={() => setForm({ ...form, current_address: form.permanent_address, current_pincode: form.permanent_pincode })}
            className="text-[10px] text-blue-600 underline hover:text-blue-800"
          >
            Same as permanent
          </button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className={`sm:col-span-2 ${trackAccent(changedSet, 'current_address')}`}>
            <label className="label">Address</label>
            <textarea className="input" rows={2} maxLength={ADDRESS_MAX_LEN} value={form.current_address || ''} onChange={(e) => setForm({ ...form, current_address: e.target.value.slice(0, ADDRESS_MAX_LEN) })} />
            <div className="flex items-center justify-between">
              <WasHint k="current_address" changedSet={changedSet} original={original} revertField={revertField} />
              <span className="text-[10px] text-gray-400 mt-0.5 ml-auto shrink-0">{(form.current_address || '').length}/{ADDRESS_MAX_LEN}</span>
            </div>
            <FieldError k="current_address" ws={ws} />
          </div>
          <div className={trackAccent(changedSet, 'current_pincode')}>
            <label className="label">PIN Code</label>
            <input className="input" maxLength={6} value={form.current_pincode || ''} onChange={(e) => setForm({ ...form, current_pincode: e.target.value.replace(/\D/g, '').slice(0, 6) })} />
            <WasHint k="current_pincode" changedSet={changedSet} original={original} revertField={revertField} />
            <FieldError k="current_pincode" ws={ws} />
          </div>
        </div>
      </div>

      <div className="border-t border-dashed pt-4 !mt-6">
        <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">Emergency Contact</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className={trackAccent(changedSet, 'emergency_contact_name')}>
            <label className="label">Name</label>
            <input className="input" value={form.emergency_contact_name || ''} onChange={(e) => setForm({ ...form, emergency_contact_name: e.target.value })} />
            <WasHint k="emergency_contact_name" changedSet={changedSet} original={original} revertField={revertField} />
            <FieldError k="emergency_contact_name" ws={ws} />
          </div>
          <div className={trackAccent(changedSet, 'emergency_contact_phone')}>
            <label className="label">Phone</label>
            <input className="input" value={form.emergency_contact_phone || ''} onChange={(e) => setForm({ ...form, emergency_contact_phone: e.target.value })} />
            <WasHint k="emergency_contact_phone" changedSet={changedSet} original={original} revertField={revertField} />
            <FieldError k="emergency_contact_phone" ws={ws} />
          </div>
        </div>
      </div>
    </div>
  );
}
