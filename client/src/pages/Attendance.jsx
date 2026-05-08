import { useState, useEffect, useRef, useCallback } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import StatusBadge from '../components/StatusBadge';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiClock, FiMapPin, FiCamera, FiUsers, FiCalendar, FiCheckCircle, FiXCircle, FiPlus, FiAlertTriangle, FiTrash2, FiEdit2 } from 'react-icons/fi';

export default function Attendance() {
  const { user, isAdmin, canDelete } = useAuth();
  const [tab, setTab] = useState('punch');
  const [myToday, setMyToday] = useState(null);
  // Mam: daily attendance detail (in/out times + leave) belongs on the
  // Attendance page next to the punch UI, not on the dashboard.
  const [myMonth, setMyMonth] = useState(null);
  // Mam: 'edit option' on leaves table — fixes typos / wrong dates /
  // floating-point hours like 1.3500000000000014.
  const [editingLeave, setEditingLeave] = useState(null);
  const [leaveEditForm, setLeaveEditForm] = useState({});
  const [dashboard, setDashboard] = useState(null);
  const [records, setRecords] = useState([]);
  const [report, setReport] = useState([]);
  const [leaves, setLeaves] = useState([]);
  const [geofences, setGeofences] = useState([]);
  // "By User" tab state
  const [allUsers, setAllUsers] = useState([]);
  const [userSearch, setUserSearch] = useState('');
  const [selectedUserId, setSelectedUserId] = useState('');
  const [userRecords, setUserRecords] = useState([]);
  const today = new Date().toISOString().split('T')[0];
  const firstOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];
  const [userDateFrom, setUserDateFrom] = useState(firstOfMonth);
  const [userDateTo, setUserDateTo] = useState(today);
  const [location, setLocation] = useState(null);
  const [address, setAddress] = useState('');
  const [photo, setPhoto] = useState(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({});
  const [filterDate, setFilterDate] = useState(new Date().toISOString().split('T')[0]);
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);

  const load = useCallback(() => {
    api.get('/attendance/my-today').then(r => setMyToday(r.data)).catch(() => {});
    // Pull current-month detail (per-day in/out + leaves) for the
    // Daily Detail timeline below the punch UI.
    api.get('/attendance/my-month').then(r => setMyMonth(r.data)).catch(() => {});
    // Everyone needs geofence list to see auto-punch status live
    api.get('/attendance/geofence').then(r => setGeofences(r.data || [])).catch(() => {});
    if (isAdmin()) {
      api.get('/attendance/dashboard').then(r => setDashboard(r.data)).catch(() => {});
      api.get(`/attendance?date=${filterDate}`).then(r => setRecords(r.data)).catch(() => {});
      api.get('/attendance/leaves').then(r => setLeaves(r.data)).catch(() => {});
      api.get('/auth/users').then(r => setAllUsers((r.data || []).filter(u => u.active !== 0))).catch(() => {});
      const m = new Date().getMonth() + 1, y = new Date().getFullYear();
      api.get(`/attendance/report?month=${m}&year=${y}`).then(r => setReport(r.data)).catch(() => {});
    }
  }, [filterDate]);

  // Load per-user records when the By User tab filters change
  useEffect(() => {
    if (!isAdmin() || tab !== 'byuser' || !selectedUserId) { setUserRecords([]); return; }
    api.get(`/attendance?user_id=${selectedUserId}&date_from=${userDateFrom}&date_to=${userDateTo}`)
      .then(r => setUserRecords(r.data))
      .catch(() => setUserRecords([]));
  }, [tab, selectedUserId, userDateFrom, userDateTo, isAdmin]);

  useEffect(() => { load(); }, [load]);

  // Location tracking + live geofence status.
  // Pings server every 30 sec so backend auto-punch (5-min rolling window)
  // triggers as soon as the user has been inside/outside long enough.
  // Stops once the day's attendance is closed (punched out).
  useEffect(() => {
    if (myToday?.punch_out_time) return; // day is done
    const trackLocation = () => {
      if (!navigator.geolocation) return;
      navigator.geolocation.getCurrentPosition(pos => {
        const loc = { latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: pos.coords.accuracy || 0 };
        setLocation(loc);
        api.post('/attendance/track-location', { ...loc, address: '' }).catch(() => {});
        // Re-fetch my-today so auto-punch events reflect in UI quickly
        api.get('/attendance/my-today').then(r => setMyToday(r.data)).catch(() => {});
      }, () => {}, { enableHighAccuracy: true, timeout: 15000 });
    };
    trackLocation(); // fire immediately
    const interval = setInterval(trackLocation, 30 * 1000); // every 30 sec
    return () => clearInterval(interval);
  }, [myToday?.punch_out_time]);

  // Client-side geofence detection (haversine) — purely for live status display
  const haversineMeters = (lat1, lon1, lat2, lon2) => {
    const R = 6371000, toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  };
  // Mirror the backend's accuracy-buffered check so the live "Inside Site"
  // pill in the Attendance page matches what punch-in / track-location see.
  const insideSite = location && geofences.length > 0
    ? geofences.filter(g => g.active !== 0).find(g => {
        const dist = haversineMeters(location.latitude, location.longitude, g.latitude, g.longitude);
        const acc = Math.min(+location.accuracy || 0, 500);
        return dist - acc <= (g.radius_meters || 200);
      })
    : null;

  // Get current location
  const getLocation = () => {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject('GPS not supported');
      navigator.geolocation.getCurrentPosition(
        pos => {
          const loc = { latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: pos.coords.accuracy || 0 };
          setLocation(loc);
          setAddress(`${loc.latitude.toFixed(6)}, ${loc.longitude.toFixed(6)}`);
          resolve(loc);
        },
        err => reject('Please enable GPS: ' + err.message),
        { enableHighAccuracy: true, timeout: 10000 }
      );
    });
  };

  // Camera functions
  const openCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 320, height: 240 } });
      streamRef.current = stream;
      setCameraOpen(true);
      setTimeout(() => { if (videoRef.current) videoRef.current.srcObject = stream; }, 100);
    } catch { toast.error('Camera not available. Please allow camera access.'); }
  };

  const capturePhoto = () => {
    if (!videoRef.current || !canvasRef.current) return;
    const canvas = canvasRef.current;
    canvas.width = 320; canvas.height = 240;
    canvas.getContext('2d').drawImage(videoRef.current, 0, 0, 320, 240);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.6);
    setPhoto(dataUrl);
    stopCamera();
  };

  const stopCamera = () => {
    if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    setCameraOpen(false);
  };

  // Punch In
  const handlePunchIn = async () => {
    if (!photo) return toast.error('Please take a selfie first');
    setLoading(true);
    try {
      const loc = await getLocation();
      const res = await api.post('/attendance/punch-in', { ...loc, address, photo, site_name: '' });
      toast.success(res.data.message);
      setPhoto(null); load();
    } catch (err) { toast.error(typeof err === 'string' ? err : err.response?.data?.error || 'Failed'); }
    setLoading(false);
  };

  // Punch Out
  const handlePunchOut = async () => {
    if (!photo) return toast.error('Please take a selfie first');
    setLoading(true);
    try {
      const loc = await getLocation();
      const res = await api.post('/attendance/punch-out', { ...loc, address, photo });
      toast.success(res.data.message);
      setPhoto(null); load();
    } catch (err) { toast.error(typeof err === 'string' ? err : err.response?.data?.error || 'Failed'); }
    setLoading(false);
  };

  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  const dateStr = now.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  return (
    <div className="space-y-4">
      <div className="flex gap-2 flex-wrap">
        <button onClick={() => setTab('punch')} className={`btn ${tab === 'punch' ? 'btn-primary' : 'btn-secondary'} text-sm`}>Punch In/Out</button>
        {isAdmin() && <>
          <button onClick={() => setTab('dashboard')} className={`btn ${tab === 'dashboard' ? 'btn-primary' : 'btn-secondary'} text-sm`}>Dashboard</button>
          <button onClick={() => setTab('records')} className={`btn ${tab === 'records' ? 'btn-primary' : 'btn-secondary'} text-sm`}>Records</button>
          <button onClick={() => setTab('byuser')} className={`btn ${tab === 'byuser' ? 'btn-primary' : 'btn-secondary'} text-sm`}>By User</button>
          <button onClick={() => setTab('report')} className={`btn ${tab === 'report' ? 'btn-primary' : 'btn-secondary'} text-sm`}>Monthly Report</button>
          <button onClick={() => setTab('geofence')} className={`btn ${tab === 'geofence' ? 'btn-primary' : 'btn-secondary'} text-sm`}>Geofence</button>
          <button onClick={() => setTab('leaves')} className={`btn ${tab === 'leaves' ? 'btn-primary' : 'btn-secondary'} text-sm`}>Leaves</button>
        </>}
      </div>

      {/* PUNCH IN/OUT TAB */}
      {tab === 'punch' && (
        <div className="max-w-md mx-auto space-y-4">
          <div className="card text-center p-6">
            <FiClock size={40} className="mx-auto text-red-600 mb-2" />
            <h2 className="text-3xl font-bold">{timeStr}</h2>
            <p className="text-sm text-gray-500">{dateStr}</p>
            <p className="text-sm font-medium text-red-600 mt-1">{user?.name}</p>
          </div>

          {/* Status */}
          {myToday ? (
            <div className={`card p-4 ${myToday.punch_out_time ? 'bg-gray-50' : 'bg-emerald-50'}`}>
              <div className="flex justify-between items-center">
                <div>
                  <p className="text-sm font-bold text-emerald-700"><FiCheckCircle className="inline mr-1" /> Punched In: {new Date(myToday.punch_in_time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}{myToday.auto_punched_in ? <span className="ml-1 text-[10px] bg-purple-100 text-purple-700 px-1 py-0.5 rounded">AUTO</span> : null}</p>
                  {myToday.punch_out_time && <p className="text-sm text-gray-600">Punched Out: {new Date(myToday.punch_out_time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}{myToday.auto_punched_out ? <span className="ml-1 text-[10px] bg-purple-100 text-purple-700 px-1 py-0.5 rounded">AUTO</span> : null}</p>}
                  {myToday.total_hours > 0 && <p className="text-sm font-bold">Total: {myToday.total_hours} hours</p>}
                </div>
                <StatusBadge status={myToday.status} />
              </div>
              {myToday.punch_in_photo && <img src={myToday.punch_in_photo} alt="Punch In" className="mt-2 w-20 h-16 rounded object-cover" />}
            </div>
          ) : (
            <div className="card p-4 bg-amber-50 text-center"><p className="text-amber-700 font-medium"><FiAlertTriangle className="inline mr-1" /> Not punched in today</p></div>
          )}

          {/* Location status card — shows whether the user is inside a geofence.
              Used purely as visual confirmation now (auto-punch disabled per
              mam's request — every punch must be manual + selfie-backed). */}
          <div className={`card p-4 border-l-4 ${insideSite ? 'border-emerald-500 bg-emerald-50' : 'border-amber-500 bg-amber-50'}`}>
            <div className="flex items-center gap-2 mb-1">
              <FiMapPin size={16} className={insideSite ? 'text-emerald-600' : 'text-amber-600'} />
              <span className={`font-bold text-sm ${insideSite ? 'text-emerald-700' : 'text-amber-700'}`}>
                {!location ? 'Getting your location…'
                  : insideSite ? `Inside ${insideSite.site_name || 'geofence'} (${Math.round(haversineMeters(location.latitude, location.longitude, insideSite.latitude, insideSite.longitude))} m)`
                  : 'Outside all geofences'}
              </span>
            </div>
            {!myToday && insideSite && <p className="text-xs text-emerald-700">You're inside the office — click Punch In below with a selfie to mark attendance.</p>}
            {!myToday && !insideSite && <p className="text-xs text-amber-700">You're outside all geofences. Move inside an office/site to punch in.</p>}
            {myToday && !myToday.punch_out_time && (
              <p className="text-xs text-emerald-700">
                ✓ Punched in at {myToday.punch_in_time ? new Date(myToday.punch_in_time).toLocaleTimeString() : '—'}.
                {!insideSite && ' Don\'t forget to Punch Out when your day is done.'}
              </p>
            )}
            {myToday?.punch_out_time && <p className="text-xs text-gray-600">Today's attendance completed.</p>}
          </div>

          {/* Camera + Manual Punch */}
          <div className="card p-4 space-y-3">
            <p className="text-[11px] text-gray-500 text-center">Take a selfie and punch in / out</p>
            {cameraOpen ? (
              <div className="text-center">
                <video ref={videoRef} autoPlay playsInline className="rounded-lg mx-auto w-full max-w-[320px]" />
                <canvas ref={canvasRef} className="hidden" />
                <div className="flex gap-2 mt-2 justify-center">
                  <button onClick={capturePhoto} className="btn btn-primary flex items-center gap-1"><FiCamera size={16} /> Capture</button>
                  <button onClick={stopCamera} className="btn btn-secondary">Cancel</button>
                </div>
              </div>
            ) : photo ? (
              <div className="text-center">
                <img src={photo} alt="Selfie" className="rounded-lg mx-auto w-40 h-32 object-cover" />
                <button onClick={() => { setPhoto(null); openCamera(); }} className="text-xs text-red-600 mt-1 underline">Retake</button>
              </div>
            ) : (
              <button onClick={openCamera} className="btn btn-secondary w-full flex items-center justify-center gap-2 py-3">
                <FiCamera size={18} /> Take Selfie
              </button>
            )}

            {location && <p className="text-xs text-gray-500 flex items-center gap-1"><FiMapPin size={12} /> {address || `${location.latitude.toFixed(6)}, ${location.longitude.toFixed(6)}`}</p>}

            {/* Punch Buttons — "Manual" prefix dropped since auto-punch is
                disabled; these are now THE punch in/out actions. */}
            {!myToday ? (
              <button onClick={handlePunchIn} disabled={loading || !photo} className="btn btn-success w-full py-3 text-sm font-bold disabled:opacity-50">
                {loading ? 'Getting Location…' : 'PUNCH IN'}
              </button>
            ) : !myToday.punch_out_time ? (
              <button onClick={handlePunchOut} disabled={loading || !photo} className="btn btn-danger w-full py-3 text-sm font-bold disabled:opacity-50">
                {loading ? 'Getting Location…' : 'PUNCH OUT'}
              </button>
            ) : (
              <p className="text-center text-emerald-600 font-bold py-2">Today's attendance completed</p>
            )}
          </div>

          {/* Leave Request */}
          <button onClick={() => { setForm({ leave_type: 'casual', from_date: '', to_date: '', reason: '' }); setModal('leave'); }} className="btn btn-secondary w-full text-sm">Apply for Leave</button>

          {/* Daily Detail — last 15 working days with in/out times + any
              leave taken on that date. Mam: "where punch/punch out [...]
              add next to attendance details". */}
          {myMonth?.days?.length > 0 && (() => {
            const recent = myMonth.days
              .filter(d => d.status !== 'future' && d.status !== 'weekend')
              .slice(-15)
              .reverse();
            if (recent.length === 0) return null;
            const fmtTime = (iso) => {
              if (!iso) return '—';
              try {
                return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
              } catch { return '—'; }
            };
            const statusPill = {
              present: 'bg-emerald-100 text-emerald-700',
              late: 'bg-amber-100 text-amber-700',
              half_day: 'bg-amber-50 text-amber-700',
              short_day: 'bg-orange-100 text-orange-800',
              on_leave: 'bg-blue-100 text-blue-700',
              absent: 'bg-red-100 text-red-700',
            };
            return (
              <div className="card p-3">
                <h4 className="text-xs font-bold text-gray-500 uppercase mb-2">Attendance Detail (last 15 working days)</h4>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-gray-500 border-b">
                        <th className="py-1.5 pr-2 font-semibold">Date</th>
                        <th className="py-1.5 pr-2 font-semibold">In</th>
                        <th className="py-1.5 pr-2 font-semibold">Out</th>
                        <th className="py-1.5 pr-2 font-semibold text-right">Hrs</th>
                        <th className="py-1.5 pr-2 font-semibold">Status</th>
                        <th className="py-1.5 font-semibold">Leave (if any)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recent.map(d => (
                        <tr key={d.date} className="border-b border-gray-50 last:border-0">
                          <td className="py-1.5 pr-2 font-medium">{d.date}</td>
                          <td className="py-1.5 pr-2 text-emerald-700">{fmtTime(d.punch_in_time)}</td>
                          <td className="py-1.5 pr-2 text-red-700">{fmtTime(d.punch_out_time)}</td>
                          <td className="py-1.5 pr-2 text-right tabular-nums font-semibold">{d.total_hours ? d.total_hours.toFixed(2) : '—'}</td>
                          <td className="py-1.5 pr-2">
                            <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${statusPill[d.status] || 'bg-gray-100 text-gray-600'}`}>
                              {d.status?.replace('_', ' ')}
                            </span>
                          </td>
                          <td className="py-1.5">
                            {d.leave ? (
                              <span className="text-[10px] text-blue-700">
                                <span className="font-bold capitalize">{d.leave.leave_type.replace('_', ' ')}</span>
                                {(d.leave.leave_type === 'short_leave' || d.leave.leave_type === 'half_day') && d.leave.from_time && d.leave.to_time && (
                                  <span className="text-blue-600"> · {d.leave.from_time}–{d.leave.to_time}</span>
                                )}
                                {d.leave.hours > 0 && <span className="text-gray-500"> · {d.leave.hours} hr</span>}
                              </span>
                            ) : <span className="text-gray-300">—</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {/* ADMIN DASHBOARD */}
      {tab === 'dashboard' && dashboard && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <div className="card p-3 border-l-4 border-red-500"><p className="text-xs text-gray-500">Total</p><p className="text-2xl font-bold">{dashboard.totalUsers}</p></div>
            <div className="card p-3 border-l-4 border-emerald-500"><p className="text-xs text-gray-500">Present</p><p className="text-2xl font-bold text-emerald-600">{dashboard.present}</p></div>
            <div className="card p-3 border-l-4 border-red-500"><p className="text-xs text-gray-500">Absent</p><p className="text-2xl font-bold text-red-600">{dashboard.absent}</p></div>
            <div className="card p-3 border-l-4 border-amber-500"><p className="text-xs text-gray-500">Late</p><p className="text-2xl font-bold text-amber-600">{dashboard.late}</p></div>
            <div className="card p-3 border-l-4 border-purple-500"><p className="text-xs text-gray-500">On Leave</p><p className="text-2xl font-bold text-purple-600">{dashboard.onLeave}</p></div>
          </div>

          {/* Not Punched In */}
          {dashboard.notPunched?.length > 0 && (
            <div className="card bg-red-50 border border-red-200">
              <h4 className="font-bold text-red-700 mb-2"><FiAlertTriangle className="inline mr-1" /> Not Punched In Today ({dashboard.notPunched.length})</h4>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">{dashboard.notPunched.map(u => (
                <div key={u.id} className="bg-white rounded p-2 text-sm">
                  <div className="font-medium">{u.name}</div>
                  <div className="text-xs text-gray-500 mb-1.5">{u.department}</div>
                  {/* Admin override — back-fill present for users who didn't
                      punch. Row is hidden from the user's own dashboard. */}
                  <button onClick={async () => {
                    const remark = prompt(`Mark ${u.name} as PRESENT for today?\n\nReason (optional, for audit):`);
                    if (remark === null) return;
                    try {
                      await api.post('/attendance/admin-mark', { user_id: u.id, date: today, status: 'present', remarks: remark });
                      toast.success(`${u.name} marked present`);
                      load();
                    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
                  }} className="btn btn-success text-[10px] py-1 px-2 w-full">
                    <FiCheckCircle className="inline mr-0.5" size={11} /> Mark Present
                  </button>
                </div>
              ))}</div>
              <p className="text-[10px] text-red-700 mt-2 italic">Admin-marked rows don't appear in the user's own dashboard or month view — only in admin reports.</p>
            </div>
          )}

          {/* Today's Records */}
          <div className="card p-0 overflow-x-auto">
            <div className="p-3 border-b"><h4 className="font-semibold">Today's Attendance</h4></div>
            <div className="overflow-x-auto"><table className="text-sm">
              <thead><tr><th>Name</th><th>Dept</th><th>In</th><th>Out</th><th>Hours</th><th>Status</th><th>Photo</th></tr></thead>
              <tbody>{dashboard.todayRecords?.map(r => (
                <tr key={r.id}>
                  <td className="font-medium">{r.user_name}{r.admin_marked ? <span className="ml-1 text-[9px] bg-amber-100 text-amber-700 px-1 rounded font-bold" title="Admin marked — hidden from user">ADMIN</span> : null}</td><td className="text-xs">{r.department}</td>
                  <td className="text-emerald-600 text-xs">{r.punch_in_time ? new Date(r.punch_in_time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '-'}{r.auto_punched_in ? <span className="ml-1 text-[9px] bg-purple-100 text-purple-700 px-1 rounded">AUTO</span> : null}</td>
                  <td className="text-red-600 text-xs">{r.punch_out_time ? new Date(r.punch_out_time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '-'}{r.auto_punched_out ? <span className="ml-1 text-[9px] bg-purple-100 text-purple-700 px-1 rounded">AUTO</span> : null}</td>
                  <td className="font-semibold">{r.total_hours || '-'}</td>
                  <td><StatusBadge status={r.status} /></td>
                  <td>{r.punch_in_photo && <img src={r.punch_in_photo} alt="" className="w-10 h-8 rounded object-cover" />}</td>
                </tr>
              ))}</tbody>
            </table></div>
          </div>
        </>
      )}

      {/* RECORDS TAB */}
      {tab === 'records' && (
        <>
          <input type="date" className="input w-48" value={filterDate} onChange={e => setFilterDate(e.target.value)} />
          <div className="card p-0 overflow-x-auto"><table className="text-sm">
            <thead><tr><th>Name</th><th>Date</th><th>In</th><th>Out</th><th>Hours</th><th>Site</th><th>Status</th><th>In Photo</th><th>Out Photo</th><th>Actions</th></tr></thead>
            <tbody>{records.map(r => (
              <tr key={r.id}>
                <td className="font-medium">{r.user_name}{r.admin_marked ? <span className="ml-1 text-[9px] bg-amber-100 text-amber-700 px-1 rounded font-bold" title="Admin marked — hidden from user">ADMIN</span> : null}</td><td>{r.date}</td>
                <td className="text-xs">{r.punch_in_time ? new Date(r.punch_in_time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '-'}{r.auto_punched_in ? <span className="ml-1 text-[9px] bg-purple-100 text-purple-700 px-1 rounded">AUTO</span> : null}</td>
                <td className="text-xs">{r.punch_out_time ? new Date(r.punch_out_time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '-'}{r.auto_punched_out ? <span className="ml-1 text-[9px] bg-purple-100 text-purple-700 px-1 rounded">AUTO</span> : null}</td>
                <td className="font-semibold">{r.total_hours || '-'}</td>
                <td className="text-xs">{r.site_name || '-'}</td>
                <td><StatusBadge status={r.status} /></td>
                <td>{r.punch_in_photo && <img src={r.punch_in_photo} alt="" className="w-10 h-8 rounded object-cover" />}</td>
                <td>{r.punch_out_photo && <img src={r.punch_out_photo} alt="" className="w-10 h-8 rounded object-cover" />}</td>
                <td>{canDelete('attendance') && <button onClick={async () => {
                  if (!confirm(`Delete attendance record for "${r.user_name}" on ${r.date}?`)) return;
                  try { await api.delete(`/attendance/${r.id}`); toast.success('Deleted'); load(); }
                  catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
                }} className="p-1 text-gray-400 hover:text-red-600" title="Delete"><FiTrash2 size={14} /></button>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </>
      )}

      {/* BY USER TAB — pick a person, see their in/out/hours over a range */}
      {tab === 'byuser' && isAdmin() && (
        <div className="space-y-4">
          <div className="card p-3">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              <div className="md:col-span-2">
                <label className="label">Search Employee</label>
                <input
                  className="input"
                  placeholder="Type name, email, or department..."
                  value={userSearch}
                  onChange={e => setUserSearch(e.target.value)}
                />
                <div className="mt-2 max-h-48 overflow-y-auto border rounded-lg bg-white">
                  {allUsers
                    .filter(u => {
                      if (!userSearch) return true;
                      const q = userSearch.toLowerCase();
                      return (u.name || '').toLowerCase().includes(q)
                        || (u.email || '').toLowerCase().includes(q)
                        || (u.department || '').toLowerCase().includes(q);
                    })
                    .slice(0, 50)
                    .map(u => (
                      <button
                        key={u.id}
                        type="button"
                        onClick={() => setSelectedUserId(u.id)}
                        className={`w-full text-left px-3 py-2 text-sm border-b last:border-b-0 hover:bg-red-50 ${selectedUserId === u.id ? 'bg-red-100 font-semibold' : ''}`}
                      >
                        {u.name} <span className="text-xs text-gray-400">— {u.department || u.role_names || u.role || 'User'}</span>
                      </button>
                    ))}
                  {allUsers.length === 0 && <p className="p-3 text-xs text-gray-400">No users loaded</p>}
                </div>
              </div>
              <div>
                <label className="label">From</label>
                <input type="date" className="input" value={userDateFrom} onChange={e => setUserDateFrom(e.target.value)} />
              </div>
              <div>
                <label className="label">To</label>
                <input type="date" className="input" value={userDateTo} onChange={e => setUserDateTo(e.target.value)} />
              </div>
            </div>
          </div>

          {!selectedUserId ? (
            <div className="card p-8 text-center text-gray-400 text-sm">Pick an employee on the left to see their attendance details</div>
          ) : (
            <>
              {/* Summary cards */}
              {(() => {
                const total = userRecords.length;
                const present = userRecords.filter(r => r.punch_in_time).length;
                const late = userRecords.filter(r => r.status === 'late').length;
                const halfDay = userRecords.filter(r => r.status === 'half_day').length;
                const autoIn = userRecords.filter(r => r.auto_punched_in).length;
                const autoOut = userRecords.filter(r => r.auto_punched_out).length;
                const totalHours = userRecords.reduce((s, r) => s + (r.total_hours || 0), 0);
                const avgHours = present > 0 ? (totalHours / present).toFixed(1) : '0';
                const selectedUser = allUsers.find(u => u.id === selectedUserId);
                return (
                  <>
                    <div className="card p-3 flex items-center justify-between">
                      <div>
                        <h4 className="font-bold text-lg">{selectedUser?.name || '—'}</h4>
                        <p className="text-xs text-gray-500">{selectedUser?.department || ''} {selectedUser?.email ? `· ${selectedUser.email}` : ''}</p>
                      </div>
                      <span className="text-xs text-gray-400">{userDateFrom} → {userDateTo}</span>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
                      <div className="card p-3"><div className="text-[11px] text-gray-500">Records</div><div className="text-2xl font-bold">{total}</div></div>
                      <div className="card p-3"><div className="text-[11px] text-gray-500">Present</div><div className="text-2xl font-bold text-emerald-600">{present}</div></div>
                      <div className="card p-3"><div className="text-[11px] text-gray-500">Late</div><div className="text-2xl font-bold text-amber-600">{late}</div></div>
                      <div className="card p-3"><div className="text-[11px] text-gray-500">Half Day</div><div className="text-2xl font-bold text-orange-600">{halfDay}</div></div>
                      <div className="card p-3"><div className="text-[11px] text-gray-500">Total Hours</div><div className="text-2xl font-bold">{totalHours.toFixed(1)}</div></div>
                      <div className="card p-3"><div className="text-[11px] text-gray-500">Avg Hours / day</div><div className="text-2xl font-bold">{avgHours}</div></div>
                    </div>
                    {(autoIn > 0 || autoOut > 0) && (
                      <div className="text-xs text-purple-700 bg-purple-50 border border-purple-200 rounded-lg px-3 py-2">
                        Auto-punched: {autoIn} in · {autoOut} out. These entries were marked automatically after 5 min inside/outside the geofence.
                      </div>
                    )}
                  </>
                );
              })()}

              {/* Detail table */}
              <div className="card p-0 overflow-x-auto">
                <div className="p-3 border-b"><h4 className="font-semibold text-sm">Daily Detail</h4></div>
                <div className="overflow-x-auto">
                  <table className="text-sm w-full">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-2 py-2 text-left">Date</th>
                        <th className="px-2 py-2">In</th>
                        <th className="px-2 py-2">Out</th>
                        <th className="px-2 py-2">Hours</th>
                        <th className="px-2 py-2 text-left">Site</th>
                        <th className="px-2 py-2">Status</th>
                        <th className="px-2 py-2">Photos</th>
                      </tr>
                    </thead>
                    <tbody>
                      {userRecords.map(r => (
                        <tr key={r.id} className="border-b">
                          <td className="px-2 py-2 font-medium">{r.date}</td>
                          <td className="px-2 py-2 text-center text-xs text-emerald-600">
                            {r.punch_in_time ? new Date(r.punch_in_time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '-'}
                            {r.auto_punched_in ? <span className="ml-1 text-[9px] bg-purple-100 text-purple-700 px-1 rounded">AUTO</span> : null}
                          </td>
                          <td className="px-2 py-2 text-center text-xs text-red-600">
                            {r.punch_out_time ? new Date(r.punch_out_time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '-'}
                            {r.auto_punched_out ? <span className="ml-1 text-[9px] bg-purple-100 text-purple-700 px-1 rounded">AUTO</span> : null}
                          </td>
                          <td className="px-2 py-2 text-center font-semibold">{r.total_hours || '-'}</td>
                          <td className="px-2 py-2 text-xs">{r.site_name || '-'}</td>
                          <td className="px-2 py-2 text-center"><StatusBadge status={r.status} /></td>
                          <td className="px-2 py-2">
                            <div className="flex gap-1 justify-center">
                              {r.punch_in_photo && <img src={r.punch_in_photo} alt="In" className="w-8 h-8 rounded object-cover" title="Punch In" />}
                              {r.punch_out_photo && <img src={r.punch_out_photo} alt="Out" className="w-8 h-8 rounded object-cover" title="Punch Out" />}
                            </div>
                          </td>
                        </tr>
                      ))}
                      {userRecords.length === 0 && (
                        <tr><td colSpan="7" className="text-center py-6 text-gray-400">No attendance records in this range</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* MONTHLY REPORT */}
      {tab === 'report' && (
        <div className="card p-0 overflow-x-auto"><table className="text-sm">
          <thead><tr><th>Employee</th><th>Dept</th><th>Present</th><th>Late</th><th>Half Day</th><th>Absent</th><th>Avg Hours</th></tr></thead>
          <tbody>{report.map(r => (
            <tr key={r.user_id}>
              <td className="font-medium">{r.name}</td><td className="text-xs">{r.department}</td>
              <td className="text-emerald-600 font-bold">{r.present_days}</td>
              <td className="text-amber-600">{r.late_days}</td>
              <td>{r.half_days}</td>
              <td className="text-red-600">{r.absent_days}</td>
              <td className="font-semibold">{r.avg_hours || '-'}h</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}

      {/* GEOFENCE SETTINGS */}
      {tab === 'geofence' && (
        <>
          <div className="flex justify-between items-center">
            <h4 className="font-semibold">Geofence Areas</h4>
            <button onClick={() => { setForm({ site_name: '', latitude: '', longitude: '', radius_meters: 200 }); setModal('geofence'); }} className="btn btn-primary flex items-center gap-2 text-sm"><FiPlus size={14} /> Add Geofence</button>
          </div>
          <p className="text-xs text-gray-500">Employees can only punch in/out when inside these areas. If no geofence set, punch from anywhere.</p>
          <div className="card p-0 overflow-x-auto"><table className="text-sm">
            <thead><tr><th>Site</th><th>Latitude</th><th>Longitude</th><th>Radius</th><th>Active</th><th>Actions</th></tr></thead>
            <tbody>{geofences.map(g => (
              <tr key={g.id}>
                <td className="font-medium">{g.site_name}</td><td className="text-xs">{g.latitude}</td><td className="text-xs">{g.longitude}</td><td>{g.radius_meters}m</td><td>{g.active ? 'Yes' : 'No'}</td>
                <td className="flex gap-1">
                  <button onClick={() => { setForm({ ...g }); setModal('edit-geofence'); }} className="text-xs text-red-600 font-bold">Edit</button>
                  <button onClick={async () => { if (!confirm('Delete this geofence?')) return; await api.delete(`/attendance/geofence/${g.id}`); toast.success('Deleted'); load(); }} className="text-xs text-red-600 font-bold">Delete</button>
                </td>
              </tr>
            ))}{geofences.length === 0 && <tr><td colSpan="6" className="text-center py-6 text-gray-400">No geofence set. Add site locations for attendance.</td></tr>}</tbody>
          </table></div>
        </>
      )}

      {/* LEAVES TAB */}
      {tab === 'leaves' && (
        <div className="card p-0 overflow-x-auto"><table className="text-sm">
          <thead><tr><th>Employee</th><th>Type</th><th>From</th><th>To</th><th>Hrs / Days</th><th>Reason</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>{leaves.map(l => {
            // For short_leave show from-time → to-time so admin can audit
            // exactly what window the employee took. For full-day leaves
            // (casual / sick / earned / comp_off) just the dates suffice.
            const isShort = l.leave_type === 'short_leave' || l.leave_type === 'half_day';
            return (
            <tr key={l.id}>
              <td className="font-medium">{l.user_name}</td><td className="capitalize">{l.leave_type?.replace('_', ' ')}</td>
              <td className="text-xs">
                <div>{l.from_date}</div>
                {isShort && l.from_time && <div className="text-[10px] text-blue-600 font-bold">{l.from_time}</div>}
              </td>
              <td className="text-xs">
                <div>{l.to_date}</div>
                {isShort && l.to_time && <div className="text-[10px] text-blue-600 font-bold">{l.to_time}</div>}
              </td>
              <td className="text-xs">
                {isShort
                  ? <span className="text-amber-700 font-bold">{l.hours ? `${(+l.hours).toFixed(2).replace(/\.?0+$/, '')} hr${l.hours !== 1 ? 's' : ''}` : '—'}</span>
                  : <span className="font-medium">{l.days} day{l.days !== 1 ? 's' : ''}</span>
                }
              </td>
              <td className="text-xs">{l.reason}</td>
              <td><StatusBadge status={l.status} /></td>
              <td>
                <div className="flex items-center gap-1">
                  {l.status === 'pending' && (
                    <>
                      <button onClick={async () => { await api.put(`/attendance/leave/${l.id}/approve`, { status: 'approved' }); toast.success('Approved'); load(); }} className="text-xs text-emerald-600 font-bold mr-1">Approve</button>
                      <button onClick={async () => { await api.put(`/attendance/leave/${l.id}/approve`, { status: 'rejected' }); toast.success('Rejected'); load(); }} className="text-xs text-red-600 font-bold mr-1">Reject</button>
                    </>
                  )}
                  <button
                    onClick={() => {
                      setEditingLeave(l);
                      setLeaveEditForm({
                        leave_type: l.leave_type || 'casual',
                        from_date: l.from_date || '',
                        to_date: l.to_date || '',
                        from_time: l.from_time || '',
                        to_time: l.to_time || '',
                        days: l.days || 0,
                        hours: l.hours ? +(+l.hours).toFixed(2) : 0,
                        reason: l.reason || '',
                      });
                    }}
                    className="p-1 text-gray-400 hover:text-blue-600"
                    title="Edit"
                  ><FiEdit2 size={14} /></button>
                  <button
                    onClick={async () => {
                      if (!confirm(`Delete this leave request for ${l.user_name}?`)) return;
                      try {
                        await api.delete(`/attendance/leave/${l.id}`);
                        toast.success('Deleted'); load();
                      } catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
                    }}
                    className="p-1 text-gray-400 hover:text-red-600"
                    title="Delete"
                  ><FiTrash2 size={14} /></button>
                </div>
              </td>
            </tr>
            );
          })}</tbody>
        </table></div>
      )}

      {/* EDIT LEAVE MODAL — admin / approver fixes typos, wrong dates,
          rounding errors. Status is NOT editable here (use Approve / Reject). */}
      <Modal isOpen={!!editingLeave} onClose={() => { setEditingLeave(null); setLeaveEditForm({}); }} title={editingLeave ? `Edit Leave — ${editingLeave.user_name}` : ''}>
        {editingLeave && (
          <form onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api.put(`/attendance/leave/${editingLeave.id}`, leaveEditForm);
              toast.success('Updated');
              setEditingLeave(null); setLeaveEditForm({}); load();
            } catch (err) { toast.error(err.response?.data?.error || 'Update failed'); }
          }} className="space-y-3">
            <div>
              <label className="label">Type</label>
              <select className="select" value={leaveEditForm.leave_type || ''} onChange={e => setLeaveEditForm({ ...leaveEditForm, leave_type: e.target.value })}>
                <option value="casual">Casual</option>
                <option value="sick">Sick</option>
                <option value="earned">Earned</option>
                <option value="half_day">Half Day</option>
                <option value="short_leave">Short Leave</option>
                <option value="comp_off">Comp Off</option>
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">From Date</label>
                <input type="date" className="input" value={leaveEditForm.from_date || ''} onChange={e => setLeaveEditForm({ ...leaveEditForm, from_date: e.target.value })} />
              </div>
              <div>
                <label className="label">To Date</label>
                <input type="date" className="input" value={leaveEditForm.to_date || ''} onChange={e => setLeaveEditForm({ ...leaveEditForm, to_date: e.target.value })} />
              </div>
            </div>
            {(leaveEditForm.leave_type === 'short_leave' || leaveEditForm.leave_type === 'half_day') && (
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="label">From Time</label>
                  <input type="time" className="input" value={leaveEditForm.from_time || ''} onChange={e => setLeaveEditForm({ ...leaveEditForm, from_time: e.target.value })} />
                </div>
                <div>
                  <label className="label">To Time</label>
                  <input type="time" className="input" value={leaveEditForm.to_time || ''} onChange={e => setLeaveEditForm({ ...leaveEditForm, to_time: e.target.value })} />
                </div>
                <div>
                  <label className="label">Hours</label>
                  <input type="number" step="0.25" className="input" value={leaveEditForm.hours || 0} onChange={e => setLeaveEditForm({ ...leaveEditForm, hours: +e.target.value })} />
                </div>
              </div>
            )}
            {!(leaveEditForm.leave_type === 'short_leave' || leaveEditForm.leave_type === 'half_day') && (
              <div>
                <label className="label">Days</label>
                <input type="number" step="0.5" className="input" value={leaveEditForm.days || 0} onChange={e => setLeaveEditForm({ ...leaveEditForm, days: +e.target.value })} />
              </div>
            )}
            <div>
              <label className="label">Reason</label>
              <textarea className="input" rows="2" value={leaveEditForm.reason || ''} onChange={e => setLeaveEditForm({ ...leaveEditForm, reason: e.target.value })} />
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t">
              <button type="button" onClick={() => { setEditingLeave(null); setLeaveEditForm({}); }} className="btn btn-secondary">Cancel</button>
              <button type="submit" className="btn btn-primary">Save</button>
            </div>
          </form>
        )}
      </Modal>

      {/* Leave Modal */}
      <Modal isOpen={modal === 'leave'} onClose={() => setModal(null)} title="Apply for Leave">
        <form onSubmit={async (e) => {
          e.preventDefault();
          // Guard — common reason this form fails: To Date < From Date. Catch
          // it client-side so mam sees a clear message instead of a backend 500.
          if (form.leave_type !== 'short_leave' && form.from_date && form.to_date && form.to_date < form.from_date) {
            toast.error('To Date cannot be earlier than From Date');
            return;
          }
          try { await api.post('/attendance/leave', form); toast.success('Leave applied'); setModal(null); load(); }
          catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
        }} className="space-y-4">
          <div><label className="label">Leave Type</label><select className="select" value={form.leave_type} onChange={e => setForm({ ...form, leave_type: e.target.value })}><option value="casual">Casual Leave</option><option value="sick">Sick Leave</option><option value="earned">Earned Leave</option><option value="half_day">Half Day</option><option value="short_leave">Short Leave (max 4hrs/month)</option><option value="comp_off">Comp Off</option></select></div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">From Date *</label>
              <input
                className="input"
                type="date"
                value={form.from_date}
                onChange={e => {
                  const v = e.target.value;
                  // Auto-align To Date if it would become invalid — so picking
                  // a new "from" doesn't silently leave an out-of-range "to".
                  setForm(f => ({
                    ...f,
                    from_date: v,
                    to_date: (!f.to_date || f.to_date < v) ? v : f.to_date,
                  }));
                }}
                required
              />
            </div>
            {form.leave_type !== 'short_leave' && (
              <div>
                <label className="label">To Date *</label>
                <input
                  className="input"
                  type="date"
                  value={form.to_date}
                  min={form.from_date || undefined}
                  onChange={e => setForm({ ...form, to_date: e.target.value })}
                  required
                />
                {form.from_date && form.to_date && form.to_date < form.from_date && (
                  <p className="text-[11px] text-red-600 mt-0.5">To Date must be on or after From Date</p>
                )}
              </div>
            )}
          </div>
          {form.leave_type === 'short_leave' && (
            <div className="grid grid-cols-2 gap-3 bg-amber-50 p-3 rounded">
              <div><label className="label">From Time *</label><input className="input" type="time" value={form.from_time || ''} onChange={e => setForm({ ...form, from_time: e.target.value })} required /></div>
              <div><label className="label">To Time *</label><input className="input" type="time" value={form.to_time || ''} onChange={e => setForm({ ...form, to_time: e.target.value })} required /></div>
              <p className="col-span-2 text-xs text-amber-600">Monthly limit: 4 hours. Exceeding will be rejected.</p>
            </div>
          )}
          <div><label className="label">Reason</label><textarea className="input" rows="2" value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} /></div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(null)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">Apply</button></div>
        </form>
      </Modal>

      {/* Edit Geofence Modal */}
      <Modal isOpen={modal === 'edit-geofence'} onClose={() => setModal(null)} title="Edit Geofence">
        <form onSubmit={async (e) => { e.preventDefault(); try { await api.put(`/attendance/geofence/${form.id}`, form); toast.success('Updated'); setModal(null); load(); } catch (err) { toast.error('Failed'); } }} className="space-y-4">
          <div><label className="label">Site Name *</label><input className="input" value={form.site_name || ''} onChange={e => setForm({ ...form, site_name: e.target.value })} required /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label">Latitude</label><input className="input" type="number" step="any" value={form.latitude || ''} onChange={e => setForm({ ...form, latitude: e.target.value })} /></div>
            <div><label className="label">Longitude</label><input className="input" type="number" step="any" value={form.longitude || ''} onChange={e => setForm({ ...form, longitude: e.target.value })} /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label">Radius (m)</label><input className="input" type="number" value={form.radius_meters || 200} onChange={e => setForm({ ...form, radius_meters: +e.target.value })} /></div>
            <div><label className="label">Active</label><select className="select" value={form.active ? '1' : '0'} onChange={e => setForm({ ...form, active: e.target.value === '1' })}><option value="1">Yes</option><option value="0">No</option></select></div>
          </div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(null)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">Update</button></div>
        </form>
      </Modal>

      {/* Geofence Modal */}
      <Modal isOpen={modal === 'geofence'} onClose={() => setModal(null)} title="Add Geofence Area">
        <form onSubmit={async (e) => { e.preventDefault(); try { await api.post('/attendance/geofence', form); toast.success('Geofence added'); setModal(null); load(); } catch (err) { toast.error(err.response?.data?.error || 'Failed'); } }} className="space-y-4">
          <div><label className="label">Site Name *</label><input className="input" value={form.site_name} onChange={e => setForm({ ...form, site_name: e.target.value })} required /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label">Latitude *</label><input className="input" type="number" step="any" value={form.latitude} onChange={e => setForm({ ...form, latitude: e.target.value })} required /></div>
            <div><label className="label">Longitude *</label><input className="input" type="number" step="any" value={form.longitude} onChange={e => setForm({ ...form, longitude: e.target.value })} required /></div>
          </div>
          <div><label className="label">Radius (meters)</label><input className="input" type="number" value={form.radius_meters} onChange={e => setForm({ ...form, radius_meters: +e.target.value })} /></div>
          <button type="button" onClick={async () => {
            try { const loc = await getLocation(); setForm(f => ({ ...f, latitude: loc.latitude, longitude: loc.longitude })); toast.success('Current location set'); }
            catch { toast.error('GPS failed'); }
          }} className="btn btn-secondary text-sm w-full"><FiMapPin className="inline mr-1" /> Use My Current Location</button>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(null)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">Save Geofence</button></div>
        </form>
      </Modal>
    </div>
  );
}
