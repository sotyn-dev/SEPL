// Admin "Location Tracking" — two views:
//
//   LIVE     : every user's most recent GPS ping (last 30 min by default)
//              with a "View on Map" button (opens Google Maps).
//   TIMELINE : pick employee + date, see every ping that day with the
//              distance-from-previous and a BEFORE / DURING / AFTER tag
//              based on punch-in / punch-out times — answers mam's
//              "where did they go between in and out".

import { useState, useEffect } from 'react';
import api from '../../api';
import toast from 'react-hot-toast';
import { FiMapPin, FiRefreshCw, FiUser, FiCalendar, FiClock, FiNavigation, FiExternalLink, FiAlertCircle } from 'react-icons/fi';
import RouteMap from '../../components/RouteMap';

const todayIso = () => new Date().toISOString().slice(0, 10);
const fmtTime = (iso) => iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '—';
const fmtDist = (m) => m == null ? '—' : (m < 1000 ? `${m} m` : `${(m / 1000).toFixed(2)} km`);
const mapsUrl = (lat, lng) => `https://www.google.com/maps?q=${lat},${lng}`;

const PHASE_PILL = {
  before: 'bg-gray-100 text-gray-600',
  during: 'bg-emerald-100 text-emerald-700 font-semibold',
  after: 'bg-amber-100 text-amber-700',
};
const PHASE_LABEL = { before: 'before in', during: 'during work', after: 'after out' };

export default function Locations() {
  const [tab, setTab] = useState('live');

  // ===== Live tab =====
  const [live, setLive] = useState(null);
  const [staleMin, setStaleMin] = useState(30);
  const [liveLoading, setLiveLoading] = useState(false);

  const loadLive = async () => {
    setLiveLoading(true);
    try {
      const r = await api.get('/admin/locations/live', { params: { stale_minutes: staleMin } });
      setLive(r.data);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to load');
    }
    setLiveLoading(false);
  };
  useEffect(() => { if (tab === 'live') loadLive(); /* eslint-disable-next-line */ }, [tab, staleMin]);

  // Auto-refresh live tab every 60s while open
  useEffect(() => {
    if (tab !== 'live') return;
    const id = setInterval(loadLive, 60 * 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line
  }, [tab, staleMin]);

  // ===== Timeline tab =====
  const [users, setUsers] = useState([]);
  const [timelineUserId, setTimelineUserId] = useState('');
  const [timelineDate, setTimelineDate] = useState(todayIso());
  const [timeline, setTimeline] = useState(null);
  const [tlLoading, setTlLoading] = useState(false);

  useEffect(() => {
    if (tab !== 'timeline') return;
    api.get('/admin/locations/users').then(r => setUsers(r.data || [])).catch(() => setUsers([]));
  }, [tab]);

  const loadTimeline = async () => {
    if (!timelineUserId) return;
    setTlLoading(true);
    try {
      const r = await api.get('/admin/locations/timeline', { params: { user_id: timelineUserId, date: timelineDate } });
      setTimeline(r.data);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to load');
      setTimeline(null);
    }
    setTlLoading(false);
  };
  useEffect(() => { if (tab === 'timeline' && timelineUserId) loadTimeline(); /* eslint-disable-next-line */ }, [timelineUserId, timelineDate]);

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-xl font-bold text-gray-800 flex items-center gap-2">
          <FiMapPin className="text-red-600" /> Location Tracking
        </h3>
        <p className="text-sm text-gray-500">
          GPS pings sent every 30 seconds while an employee has the Attendance page open.
          Use Live for "where is everyone right now", Timeline for "where did one person go between punch-in and punch-out".
        </p>
      </div>

      <div className="flex gap-2 flex-wrap">
        {['live', 'timeline'].map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 rounded-lg text-sm font-medium border ${tab === t ? 'bg-red-600 text-white border-red-600' : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'}`}>
            {t === 'live' ? 'Live (now)' : 'Timeline (by user / date)'}
          </button>
        ))}
      </div>

      {/* ============ LIVE TAB ============ */}
      {tab === 'live' && (
        <>
          <div className="card p-4 flex flex-col sm:flex-row gap-3 sm:items-end justify-between">
            <div>
              <label className="label">Show pings from the last…</label>
              <select className="select w-48" value={staleMin} onChange={e => setStaleMin(parseInt(e.target.value, 10))}>
                <option value="5">5 minutes</option>
                <option value="15">15 minutes</option>
                <option value="30">30 minutes</option>
                <option value="60">1 hour</option>
                <option value="180">3 hours</option>
                <option value="720">12 hours</option>
              </select>
            </div>
            <div className="flex items-center gap-3">
              {live && (
                <span className="text-xs text-gray-500">
                  As of {new Date(live.as_of).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · auto-refresh every 60s
                </span>
              )}
              <button onClick={loadLive} disabled={liveLoading} className="btn btn-secondary flex items-center gap-2">
                <FiRefreshCw className={liveLoading ? 'animate-spin' : ''} size={14} /> Refresh
              </button>
            </div>
          </div>

          {live && live.users.length === 0 && (
            <div className="card p-6 text-center text-gray-400 text-sm">
              No active GPS pings in the last {staleMin} minutes. Employees only ping while they have the Attendance page open in their browser.
            </div>
          )}

          {live && live.users.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {live.users.map(u => {
                // GPS_OFF = the user's browser couldn't get a GPS fix even
                // though their network ping reached us. Network alive, GPS
                // off / permission denied / timed out. Show as red card.
                const gpsOff = u.site_name === 'GPS_OFF' || u.latitude == null || u.longitude == null;
                const inSite = !gpsOff && u.site_name && u.site_name !== 'Outside';
                const borderColor = gpsOff ? 'border-red-500' : (inSite ? 'border-emerald-500' : 'border-amber-500');
                const pillStyle = gpsOff
                  ? 'bg-red-100 text-red-700'
                  : (inSite ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700');
                const pillLabel = gpsOff ? '⚠ GPS OFF' : (inSite ? u.site_name : 'Outside any site');
                return (
                  <div key={u.user_id}
                    className={`card p-4 border-l-4 ${borderColor}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="font-semibold text-gray-800">{u.user_name}</div>
                        <div className="text-[11px] text-gray-500">{u.department || u.role}</div>
                      </div>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${pillStyle}`}>
                        {pillLabel}
                      </span>
                    </div>
                    <div className="mt-3 text-xs text-gray-600 leading-relaxed">
                      {gpsOff ? (
                        <div className="text-red-600 italic">
                          Network alive but GPS not available
                          {u.address && <span className="text-gray-500 not-italic"> · {u.address.replace('-', ' ')}</span>}
                        </div>
                      ) : (
                        <div className="flex items-start gap-1.5">
                          <FiMapPin size={11} className="mt-0.5 text-red-500 flex-shrink-0" />
                          <span className="break-words">{u.address || `${u.latitude.toFixed(5)}, ${u.longitude.toFixed(5)}`}</span>
                        </div>
                      )}
                      <div className="flex items-center gap-1.5 mt-1 text-gray-500">
                        <FiClock size={11} />
                        <span>{fmtTime(u.time)} · {u.minutes_ago === 0 ? 'just now' : `${u.minutes_ago} min ago`}</span>
                      </div>
                    </div>
                    <div className="mt-3 flex items-center gap-3 flex-wrap">
                      {!gpsOff && (
                        <a
                          href={mapsUrl(u.latitude, u.longitude)}
                          target="_blank" rel="noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-red-600 hover:underline font-medium"
                        >
                          <FiExternalLink size={12} /> View on Google Maps
                        </a>
                      )}
                      {/* One-click jump to this person's full-day timeline.
                          Pre-fills the Timeline tab with their user_id +
                          today's date so mam doesn't re-pick from dropdowns. */}
                      <button
                        onClick={() => {
                          setTimelineUserId(String(u.user_id));
                          setTimelineDate(todayIso());
                          setTab('timeline');
                        }}
                        className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline font-medium"
                      >
                        <FiNavigation size={12} /> View Today's Timeline
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* ============ TIMELINE TAB ============ */}
      {tab === 'timeline' && (
        <>
          <div className="card p-4 grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
            <div>
              <label className="label flex items-center gap-1"><FiUser size={12} /> Employee</label>
              <select className="select" value={timelineUserId} onChange={e => setTimelineUserId(e.target.value)}>
                <option value="">Pick an employee…</option>
                {users.map(u => <option key={u.id} value={u.id}>{u.name}{u.department ? ' — ' + u.department : ''}</option>)}
              </select>
            </div>
            <div>
              <label className="label flex items-center gap-1"><FiCalendar size={12} /> Date</label>
              <input type="date" className="input" value={timelineDate} onChange={e => setTimelineDate(e.target.value)} />
            </div>
            <button onClick={loadTimeline} disabled={!timelineUserId || tlLoading} className="btn btn-primary flex items-center gap-2 justify-center">
              <FiRefreshCw className={tlLoading ? 'animate-spin' : ''} size={14} /> Load Timeline
            </button>
          </div>

          {!timelineUserId && (
            <div className="card p-6 text-center text-gray-400 text-sm">
              Pick an employee above to see their GPS movement on the selected date.
            </div>
          )}

          {timeline && (
            <>
              {/* Summary card with punch in / out + total distance */}
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                <div className="card p-4 bg-emerald-50 border-l-4 border-emerald-500">
                  <div className="text-[10px] text-gray-500 uppercase font-semibold">Punch In</div>
                  <div className="text-lg font-bold text-gray-800 mt-1">{fmtTime(timeline.attendance.punch_in_time)}</div>
                  <div className="text-[10px] text-gray-500 truncate" title={timeline.attendance.punch_in_address}>
                    {timeline.attendance.punch_in_address || '—'}
                  </div>
                </div>
                <div className="card p-4 bg-red-50 border-l-4 border-red-500">
                  <div className="text-[10px] text-gray-500 uppercase font-semibold">Punch Out</div>
                  <div className="text-lg font-bold text-gray-800 mt-1">{fmtTime(timeline.attendance.punch_out_time)}</div>
                  <div className="text-[10px] text-gray-500 truncate" title={timeline.attendance.punch_out_address}>
                    {timeline.attendance.punch_out_address || '—'}
                  </div>
                </div>
                <div className="card p-4 bg-blue-50 border-l-4 border-blue-500">
                  <div className="text-[10px] text-gray-500 uppercase font-semibold">Hours Worked</div>
                  <div className="text-lg font-bold text-gray-800 mt-1">{timeline.attendance.total_hours || '—'}</div>
                  <div className="text-[10px] text-gray-500">{timeline.attendance.status || '—'}</div>
                </div>
                <div className="card p-4 bg-purple-50 border-l-4 border-purple-500">
                  <div className="text-[10px] text-gray-500 uppercase font-semibold">Total Distance Moved</div>
                  <div className="text-lg font-bold text-gray-800 mt-1">{fmtDist(timeline.total_distance_m)}</div>
                  <div className="text-[10px] text-gray-500">{timeline.ping_count} GPS pings</div>
                </div>
              </div>

              {!timeline.attendance.punch_in_time && timeline.pings.length > 0 && (
                <div className="card p-3 bg-amber-50 border-l-4 border-amber-400 flex items-start gap-2 text-xs text-amber-900">
                  <FiAlertCircle className="mt-0.5 flex-shrink-0" />
                  <div>This employee has GPS pings but didn't punch in on {timeline.date}. The "during work" tag won't apply.</div>
                </div>
              )}

              {timeline.suspicious_count > 0 && (
                <div className="card p-3 bg-red-50 border-l-4 border-red-500 flex items-start gap-2 text-xs text-red-900">
                  <FiAlertCircle className="mt-0.5 flex-shrink-0" />
                  <div>
                    <strong>{timeline.suspicious_count} suspicious ping{timeline.suspicious_count > 1 ? 's' : ''} detected.</strong> Travel speed exceeded 120 km/h between pings — physically impossible. Most likely cause: a fake-GPS app, weak GPS signal, or cell-tower triangulation glitch. Suspicious pings are <span className="font-bold">excluded from the total distance</span> and tagged ⚠ FAKE in the table below. If this keeps happening for one employee, consider asking them to re-install the browser / disable any "Mock Location" developer setting.
                  </div>
                </div>
              )}

              {/* Embedded route map — draws the day's GPS pings as a red
                  polyline with start (green) / end (red) markers and the
                  office geofence as a faint blue circle. Mam's exact ask:
                  "draw red line office to outside outside to office". */}
              {timeline.pings.length > 0 && (
                <div className="card p-0 overflow-hidden">
                  <div className="px-4 py-3 border-b bg-gray-50 flex items-center justify-between">
                    <h4 className="font-semibold text-gray-700 flex items-center gap-2">
                      <FiMapPin size={14} className="text-red-600" /> Route Map ({timeline.pings.length} points · total {(timeline.total_distance_m/1000).toFixed(2)} km)
                    </h4>
                    <span className="text-[11px] text-gray-400">🟢 start · 🔴 last seen · blue circle = office</span>
                  </div>
                  <RouteMap
                    /* Drop suspicious teleport pings from the line so the
                       trail reflects real movement, not GPS-spoof zigzags. */
                    pings={timeline.pings.filter(p => !p.suspicious).map(p => ({ ...p, time_str: fmtTime(p.time) }))}
                    geofences={timeline.geofences || []}
                    height={420}
                  />
                </div>
              )}

              {timeline.pings.length === 0 && (
                <div className="card p-6 text-center text-gray-400 text-sm">
                  No GPS pings recorded for this employee on {timeline.date}.
                </div>
              )}

              {timeline.pings.length > 0 && (
                <div className="card p-0 overflow-hidden">
                  <div className="px-4 py-3 border-b bg-gray-50 flex flex-wrap items-center justify-between gap-2">
                    <h4 className="font-semibold text-gray-700 flex items-center gap-2">
                      <FiNavigation size={14} className="text-red-600" /> Movement Timeline ({timeline.pings.length} pings)
                    </h4>
                    <div className="flex items-center gap-3 flex-wrap">
                      {/* Draw the whole day's route as a single Google Maps
                          directions URL with sampled waypoints. Free Maps
                          allows ~9 waypoints between origin & destination,
                          so we evenly downsample longer ping lists. */}
                      <a
                        href={(() => {
                          const pings = timeline.pings;
                          const maxStops = 11; // origin + 9 waypoints + destination
                          let sample = pings;
                          if (pings.length > maxStops) {
                            const step = (pings.length - 1) / (maxStops - 1);
                            sample = Array.from({ length: maxStops }, (_, i) => pings[Math.round(i * step)]);
                          }
                          const path = sample.map(p => `${p.latitude},${p.longitude}`).join('/');
                          return `https://www.google.com/maps/dir/${path}`;
                        })()}
                        target="_blank" rel="noreferrer"
                        className="inline-flex items-center gap-1 text-xs bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-md font-medium"
                        title={timeline.pings.length > 11 ? `Sampled to 11 of ${timeline.pings.length} pings (Google Maps free limit)` : 'Full route'}
                      >
                        <FiExternalLink size={12} /> Draw Route on Google Maps
                      </a>
                      <span className="text-[11px] text-gray-400">green = during work · grey = before in · amber = after out</span>
                    </div>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="text-xs w-full">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="text-left px-2 py-2 text-gray-500 uppercase font-semibold w-16">Time</th>
                          <th className="text-left px-2 py-2 text-gray-500 uppercase font-semibold w-24">Phase</th>
                          <th className="text-left px-2 py-2 text-gray-500 uppercase font-semibold w-24">Site</th>
                          <th className="text-left px-2 py-2 text-gray-500 uppercase font-semibold">Address / Coordinates</th>
                          <th className="text-right px-2 py-2 text-gray-500 uppercase font-semibold w-24">Moved</th>
                          <th className="text-right px-2 py-2 text-gray-500 uppercase font-semibold w-24">Map</th>
                        </tr>
                      </thead>
                      <tbody>
                        {timeline.pings.map((p, i) => (
                          <tr key={p.id} className={`border-t ${p.suspicious ? 'bg-red-50 hover:bg-red-100' : 'hover:bg-gray-50'}`}>
                            <td className="px-2 py-1.5 font-mono text-[11px]">{fmtTime(p.time)}</td>
                            <td className="px-2 py-1.5">
                              <span className={`px-2 py-0.5 rounded text-[10px] ${PHASE_PILL[p.phase] || 'bg-gray-100 text-gray-600'}`}>
                                {PHASE_LABEL[p.phase] || p.phase}
                              </span>
                              {p.suspicious && (
                                <span className="ml-1 px-1.5 py-0.5 rounded text-[9px] bg-red-200 text-red-800 font-bold" title={`Travel speed ${p.speed_kmh} km/h is impossible — likely GPS spoof or signal glitch`}>
                                  ⚠ FAKE
                                </span>
                              )}
                            </td>
                            <td className="px-2 py-1.5 text-gray-700">
                              {p.site_name && p.site_name !== 'Outside'
                                ? <span className="text-emerald-700 font-medium">{p.site_name}</span>
                                : <span className="text-amber-700">Outside</span>}
                            </td>
                            <td className="px-2 py-1.5 text-gray-600 max-w-[260px] truncate" title={p.address}>
                              {p.address || `${p.latitude.toFixed(5)}, ${p.longitude.toFixed(5)}`}
                            </td>
                            <td className="px-2 py-1.5 text-right text-gray-500">
                              {i === 0 ? '—' : fmtDist(p.dist_from_prev_m)}
                              {p.suspicious && <div className="text-[9px] text-red-600">@ {p.speed_kmh} km/h ⚠</div>}
                            </td>
                            <td className="px-2 py-1.5 text-right">
                              <a href={mapsUrl(p.latitude, p.longitude)} target="_blank" rel="noreferrer"
                                className="text-red-600 hover:underline inline-flex items-center gap-1">
                                <FiExternalLink size={10} /> Open
                              </a>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
