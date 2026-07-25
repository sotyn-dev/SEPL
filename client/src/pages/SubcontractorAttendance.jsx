// Sub-contractor self-service attendance (director ask, 2026-07-25): a
// sub-contractor logs in with their own account (linked via
// sub_contractors.user_id — see routes/subcontractors.js POST
// /:id/create-login) and submits their crew's daily attendance directly:
// named workers, present/absent, and team photos (max 4 workers visible
// per photo — larger crews just need more photos). On save this bridges
// into the existing contractor_attendance table so DPR's "Contractors on
// Site" pre-fill picks it up automatically.
//
// Site access is gated on an ACTIVE Work Order ("no work order no
// attendance") — /my-sites only returns WO-backed sites, and the server
// re-checks on every submit.

import { useState, useEffect } from 'react';
import api from '../api';
import toast from 'react-hot-toast';
import { FiPlus, FiCamera, FiTrash2, FiCheckCircle, FiUsers, FiSave } from 'react-icons/fi';

export default function SubcontractorAttendance() {
  const [sites, setSites] = useState([]);
  const [siteId, setSiteId] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [workers, setWorkers] = useState([]);
  const [present, setPresent] = useState({}); // worker_id -> bool
  const [photos, setPhotos] = useState([]); // array of uploaded URLs
  const [notes, setNotes] = useState('');
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newWorkerName, setNewWorkerName] = useState('');
  const [newWorkerPhone, setNewWorkerPhone] = useState('');
  const [addingWorker, setAddingWorker] = useState(false);

  const loadSites = () => api.get('/subcontractor-attendance/my-sites').then(r => {
    setSites(r.data || []);
    if (!siteId && r.data?.length === 1) setSiteId(String(r.data[0].site_id));
  }).catch(() => setSites([]));

  const loadWorkers = () => api.get('/subcontractor-attendance/my-workers').then(r => setWorkers(r.data || [])).catch(() => setWorkers([]));

  useEffect(() => { loadSites(); loadWorkers(); /* eslint-disable-next-line */ }, []);

  // Pull today's (or the picked date's) existing submission for this site so
  // the crew's present/absent + photos re-populate for edit-in-place.
  useEffect(() => {
    if (!siteId || !date) { setPresent({}); setPhotos([]); setNotes(''); return; }
    api.get('/subcontractor-attendance/attendance', { params: { site_id: siteId, date } }).then(r => {
      const data = r.data;
      if (!data) { setPresent({}); setPhotos([]); setNotes(''); return; }
      const p = {};
      (data.workers || []).forEach(w => { p[w.worker_id] = !!w.present; });
      setPresent(p);
      setPhotos((data.photos || []).map(ph => ph.photo_url));
      setNotes(data.notes || '');
    }).catch(() => {});
  }, [siteId, date]);

  const togglePresent = (workerId) => setPresent(p => ({ ...p, [workerId]: !p[workerId] }));

  const addWorker = async (e) => {
    e.preventDefault();
    if (!newWorkerName.trim()) return;
    setAddingWorker(true);
    try {
      await api.post('/subcontractor-attendance/my-workers', { name: newWorkerName.trim(), phone: newWorkerPhone.trim() || null });
      setNewWorkerName(''); setNewWorkerPhone('');
      toast.success('Worker added to roster');
      loadWorkers();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed to add worker'); }
    finally { setAddingWorker(false); }
  };

  const presentCount = Object.values(present).filter(Boolean).length;
  const minPhotosNeeded = Math.ceil(presentCount / 4) || 0;

  const uploadPhoto = async (file) => {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const { data } = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      setPhotos(p => [...p, data.url]);
    } catch (err) { toast.error('Photo upload failed'); }
    finally { setUploading(false); }
  };

  const removePhoto = (i) => setPhotos(photos.filter((_, idx) => idx !== i));

  const submit = async () => {
    if (!siteId || !date) { toast.error('Pick a site and date'); return; }
    if (presentCount === 0) { toast.error('Mark at least one worker present'); return; }
    setSaving(true);
    try {
      const workersPayload = workers.map(w => ({ worker_id: w.id, present: !!present[w.id] }));
      const { data } = await api.post('/subcontractor-attendance/attendance', {
        site_id: siteId, date, workers: workersPayload, photos, notes,
      });
      toast.success(`Attendance saved — ${data.present_count} present`);
      if (data.warning) toast(data.warning, { icon: '⚠️', duration: 7000 });
    } catch (err) { toast.error(err.response?.data?.error || 'Failed to save'); }
    finally { setSaving(false); }
  };

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="text-xs text-gray-600 bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-100 rounded-lg px-4 py-2.5">
        Mark today's crew attendance. Keep at most <b>4 workers visible per photo</b> — add more photos for a bigger crew. This feeds the site's "Contractors on Site" for the day automatically.
      </div>

      <div className="card p-4 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="label">Site</label>
            <select className="select w-full" value={siteId} onChange={e => setSiteId(e.target.value)}>
              <option value="">-- Select site --</option>
              {sites.map(s => <option key={s.site_id} value={s.site_id}>{s.site_name}{s.wo_number ? ` (${s.wo_number})` : ''}</option>)}
            </select>
            {sites.length === 0 && <p className="text-xs text-amber-600 mt-1">No active Work Order yet — ask admin/site engineer to issue one for you before you can submit attendance ("no work order, no attendance").</p>}
          </div>
          <div>
            <label className="label">Date</label>
            <input type="date" className="input w-full" value={date} onChange={e => setDate(e.target.value)} />
          </div>
        </div>
      </div>

      <div className="card p-4 space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="font-semibold flex items-center gap-1.5"><FiUsers size={15} /> Crew Attendance</h4>
          <span className="text-xs text-gray-500">{presentCount} / {workers.length} present</span>
        </div>
        {workers.length === 0 && <p className="text-xs text-gray-400 py-2">No workers in your roster yet — add them below.</p>}
        <div className="space-y-1.5">
          {workers.map(w => (
            <label key={w.id} className="flex items-center gap-2 p-2 rounded-lg border border-gray-100 hover:bg-gray-50 cursor-pointer">
              <input type="checkbox" checked={!!present[w.id]} onChange={() => togglePresent(w.id)} className="w-4 h-4" />
              <span className="text-sm font-medium">{w.name}</span>
              {w.phone && <span className="text-xs text-gray-400">{w.phone}</span>}
            </label>
          ))}
        </div>
        <form onSubmit={addWorker} className="flex gap-2 pt-2 border-t border-gray-100">
          <input className="input text-sm flex-1" placeholder="Worker name" value={newWorkerName} onChange={e => setNewWorkerName(e.target.value)} />
          <input className="input text-sm w-32" placeholder="Phone (optional)" value={newWorkerPhone} onChange={e => setNewWorkerPhone(e.target.value)} />
          <button type="submit" disabled={addingWorker} className="btn btn-secondary text-xs flex items-center gap-1"><FiPlus size={12} /> Add</button>
        </form>
      </div>

      <div className="card p-4 space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="font-semibold flex items-center gap-1.5"><FiCamera size={15} /> Team Photos</h4>
          <span className={`text-xs ${photos.length < minPhotosNeeded ? 'text-amber-600' : 'text-emerald-600'}`}>
            {photos.length} photo{photos.length === 1 ? '' : 's'} {minPhotosNeeded > 0 ? `(need ${minPhotosNeeded}+ for ${presentCount} present, max 4/photo)` : ''}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          {photos.map((url, i) => (
            <div key={i} className="relative">
              <img src={url} alt="" className="w-20 h-16 object-cover rounded border border-gray-200" />
              <button type="button" onClick={() => removePhoto(i)} className="absolute -top-1.5 -right-1.5 bg-white rounded-full p-0.5 shadow text-red-500"><FiTrash2 size={12} /></button>
            </div>
          ))}
          <label className="w-20 h-16 rounded border-2 border-dashed border-gray-300 flex items-center justify-center cursor-pointer text-gray-400 hover:border-blue-400 hover:text-blue-500">
            {uploading ? <span className="text-[10px]">...</span> : <FiPlus size={18} />}
            <input type="file" accept="image/*" capture="environment" className="hidden" disabled={uploading}
              onChange={e => { const f = e.target.files?.[0]; if (f) uploadPhoto(f); e.target.value = ''; }} />
          </label>
        </div>
      </div>

      <div className="card p-4 space-y-2">
        <label className="label">Notes (optional)</label>
        <textarea className="input w-full" rows="2" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Anything mam should know about today's crew" />
      </div>

      <button onClick={submit} disabled={saving} className="btn btn-primary flex items-center gap-2 w-full justify-center">
        {saving ? <FiCheckCircle className="animate-spin" /> : <FiSave />} Save Today's Attendance
      </button>
    </div>
  );
}
