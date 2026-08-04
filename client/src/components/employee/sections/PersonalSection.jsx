import { FiUser } from 'react-icons/fi';
import WasHint, { FieldError, trackAccent } from '../WasHint';
import { PHOTO_SLOT } from '../useEmployeeForm';
import { DOB_MAX } from '../../../constants/employeeValidation';

const GENDERS = ['Male', 'Female', 'Other'];
const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];

export default function PersonalSection({ ws }) {
  const { form, setForm, changedSet, original, revertField } = ws;
  const photoPreview = form[PHOTO_SLOT.slot] ? URL.createObjectURL(form[PHOTO_SLOT.slot]) : form.photo_url;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <div className="w-16 h-16 rounded-full bg-gray-100 border border-gray-200 overflow-hidden flex items-center justify-center shrink-0">
          {photoPreview ? <img src={photoPreview} alt="" className="w-full h-full object-cover" /> : <FiUser className="text-gray-300" size={28} />}
        </div>
        <div>
          <label className="label">Photo <span className="text-gray-400 font-normal text-[10px]">(JPG / PNG, max 2 MB)</span></label>
          <input
            className="input"
            type="file"
            accept=".jpg,.jpeg,.png"
            onChange={(e) => {
              const file = e.target.files?.[0] || null;
              if (file && file.size > 2 * 1024 * 1024) { e.target.value = ''; return; }
              setForm({ ...form, [PHOTO_SLOT.slot]: file });
            }}
          />
          {form[PHOTO_SLOT.slot] && (
            <p className="text-[10px] text-blue-600 mt-0.5 flex items-center gap-1.5">
              Selected: {form[PHOTO_SLOT.slot].name}
              <button type="button" onClick={() => setForm({ ...form, [PHOTO_SLOT.slot]: null })} className="underline hover:text-blue-900">revert</button>
            </p>
          )}
        </div>
      </div>

      <div className={trackAccent(changedSet, 'name')}>
        <label className="label">Name *</label>
        <input className="input" value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        <WasHint k="name" changedSet={changedSet} original={original} revertField={revertField} />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className={trackAccent(changedSet, 'date_of_birth')}>
          <label className="label">Date of Birth</label>
          <input className="input" type="date" max={DOB_MAX} value={form.date_of_birth || ''} onChange={(e) => setForm({ ...form, date_of_birth: e.target.value })} />
          <WasHint k="date_of_birth" changedSet={changedSet} original={original} revertField={revertField} />
          <FieldError k="date_of_birth" ws={ws} />
        </div>
        <div className={trackAccent(changedSet, 'gender')}>
          <label className="label">Gender</label>
          <select className="select" value={form.gender || ''} onChange={(e) => setForm({ ...form, gender: e.target.value })}>
            <option value="">Select…</option>
            {GENDERS.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
          <WasHint k="gender" changedSet={changedSet} original={original} revertField={revertField} />
        </div>
        <div className={trackAccent(changedSet, 'blood_group')}>
          <label className="label">Blood Group</label>
          <select className="select" value={form.blood_group || ''} onChange={(e) => setForm({ ...form, blood_group: e.target.value })}>
            <option value="">Select…</option>
            {BLOOD_GROUPS.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
          <WasHint k="blood_group" changedSet={changedSet} original={original} revertField={revertField} />
        </div>
      </div>

      <div className={trackAccent(changedSet, 'father_spouse_name')}>
        <label className="label">Father's / Spouse's Name</label>
        <input className="input" value={form.father_spouse_name || ''} onChange={(e) => setForm({ ...form, father_spouse_name: e.target.value })} />
        <WasHint k="father_spouse_name" changedSet={changedSet} original={original} revertField={revertField} />
      </div>
    </div>
  );
}
