import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import StatusBadge from '../components/StatusBadge';
import { useAuth } from '../context/AuthContext';
import { FiTarget, FiShoppingCart, FiTool, FiAlertCircle, FiUsers, FiCheckSquare, FiUpload, FiClock, FiAlertTriangle, FiExternalLink, FiCalendar, FiHelpCircle, FiTrendingUp } from 'react-icons/fi';
import { LuIndianRupee } from 'react-icons/lu';
import ErpMantraBanner from '../components/ErpMantraBanner';
import DashHero3D from '../components/DashHero3D';
import DashboardHelpTickets from '../components/DashboardHelpTickets';
import DashboardAssignments from '../components/DashboardAssignments';
import DashboardRaci from '../components/DashboardRaci';
import { fmtDate } from '../utils/datetime';

export default function Dashboard() {
  const { isAdmin, user, canView } = useAuth();
  const [perf, setPerf] = useState(null);
  const [myAttendance, setMyAttendance] = useState(null);

  const loadPersonal = () => {
    // Current month's attendance summary — only relevant for regular users
    // who actually punch in/out. Admin doesn't personally punch attendance
    // (they monitor everyone's), so skip the API call to avoid the noisy
    // "18 absent" figure that mam flagged.
    if (!isAdmin()) {
      api.get('/attendance/my-month').then(r => setMyAttendance(r.data)).catch(() => setMyAttendance(null));
    }
  };

  useEffect(() => {
    loadPersonal();
    // Team performance this week — auto-scored live from SOTYN.AI activity. Admin-only
    // (endpoint is scoring-gated); non-admins just don't see the panel.
    if (isAdmin()) {
      // Mam 2026-08-17: "gamification will do as per last week scoring average"
      // — the widget now reads the CHAMPIONS engine (real scorecard scores,
      // same numbers as /champions and each person's Scorecard page) for the
      // last COMPLETED Mon-Sat week, instead of the old ad-hoc activity
      // counter that showed 0% for everyone.
      const prevMonday = (() => {
        const d = new Date(Date.now() + 5.5 * 3600 * 1000);   // IST
        const dow = d.getUTCDay();
        d.setUTCDate(d.getUTCDate() + (dow === 0 ? -6 : 1 - dow) - 7);
        return d.toISOString().slice(0, 10);
      })();
      api.get(`/gamification/leaderboard?period=week&date=${prevMonday}`)
        .then(r => setPerf(r.data)).catch(() => setPerf(null));
    }
  }, []);

  // Mam (2026-05-22): the 8 colour-coded KPI tiles (Total Leads /
  // Won Deals / Active Orders / Installations / Open Complaints /
  // Employees / Pending Expenses / Candidates) were removed from the
  // top of the dashboard.  Each module already has its own page +
  // filters that give richer detail than a single number, and the
  // tiles were duplicating those numbers without adding value.
  // The drill-down was a nice-to-have but mam asked to clear the
  // visual noise.  Kept the data fetcher intact (no schema change)
  // in case we want to bring them back behind an admin toggle later.

  const hr = new Date().getHours();
  const greeting = hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';

  return (
    <div className="dash3d space-y-6">
      {/* 3D hero banner — greeting + date on a navy drafting sheet with a
          floating iso tower (mam 2026-08-12: "dashboard look like 3d type").
          Also injects the .dash3d card-depth styles used page-wide. */}
      <DashHero3D greeting={greeting} name={(user?.name || 'there').split(' ')[0]} />

      {/* Daily SOTYN.AI-culture mantra — rotates by day-of-year so the whole
          team sees the same quote in their morning standup. */}
      <ErpMantraBanner />

      {/* Team Performance — LAST completed week, straight from the Champions
          engine (mam 2026-08-17: "gamification will do as per last week
          scoring average") — the same real scorecard scores as /champions and
          each person's Scorecard page, not the old ad-hoc activity counter.
          Admin-only, hidden when there's no data. */}
      {isAdmin() && (perf?.individuals?.length > 0 || perf?.not_qualified?.length > 0 || perf?.teams?.length > 0) && (() => {
        // Every ASSIGNED person shows their score (mam 2026-08-17): qualified
        // players first (engine-ranked), then below-activity players by score.
        const ranked = [
          ...(perf.individuals || []),
          ...(perf.not_qualified || []).filter(u => u.score != null).sort((a, b) => b.score - a.score),
        ];
        const top = ranked.slice(0, 8);
        const medal = (i) => (i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`);
        const bar = (s) => (s >= 80 ? 'from-emerald-400 to-emerald-600' : s >= 50 ? 'from-amber-400 to-amber-500' : 'from-rose-400 to-rose-500');
        const av = ['bg-indigo-500', 'bg-emerald-500', 'bg-amber-500', 'bg-rose-500', 'bg-sky-500', 'bg-violet-500', 'bg-teal-500', 'bg-orange-500'];
        // Display scores as VARIANCE vs plan (achievement − 100): on plan reads 0%,
        // behind reads negative, ahead reads +ve (mam 2026-07-04: "performance in
        // negative"). Bars, medals, sort + the Champions engine stay on the raw
        // achievement % — this only rewrites the number shown.
        const vsPlan = (n) => { const v = Math.round(n) - 100; return `${v > 0 ? '+' : ''}${v}%`; };
        // Teams come pre-averaged + pre-ranked from the leaderboard (average of
        // qualified members' engine scores; members sorted by rank, unscored last).
        const teamRows = (perf.teams || []).map(t => ({
          id: t.team_id, name: t.name, motto: t.motto,
          // score_all = average of every assigned member (qualified or not)
          avg: (t.score_all ?? t.score) != null ? Math.round(t.score_all ?? t.score) : null,
          members: t.members || [],
        })).sort((a, b) => (b.avg ?? -1e9) - (a.avg ?? -1e9));
        const hasTeams = teamRows.some(t => t.members.length > 0);
        // Header = last week's scoring average across all qualified players.
        const headerAvg = ranked.length
          ? Math.round(ranked.reduce((a, u) => a + (u.score || 0), 0) / ranked.length)
          : 0;
        return (
          <div className="d3-card rounded-2xl shadow-sm border border-gray-100 overflow-hidden bg-white">
            <div className="bg-gradient-to-r from-indigo-600 via-indigo-500 to-red-500 px-5 py-4 flex items-center justify-between">
              <div className="flex items-center gap-2.5 text-white">
                <div className="w-9 h-9 rounded-xl bg-white/20 flex items-center justify-center"><FiTrendingUp size={20} /></div>
                <div>
                  <h3 className="font-bold text-lg leading-tight">Performance — Last Week</h3>
                  <p className="text-[11px] text-white/80">Scorecard average · {fmtDate(perf.start)} – {fmtDate(perf.end)}{hasTeams ? ` · ${teamRows.length} teams` : ''}</p>
                </div>
              </div>
              <div className="text-right text-white">
                <div className="text-3xl font-extrabold leading-none">{headerAvg ? vsPlan(headerAvg) : '—'}</div>
                <div className="text-[10px] text-white/80 uppercase tracking-wide">team avg</div>
              </div>
            </div>
            {hasTeams ? (
              <div className="p-4 space-y-3">
                {teamRows.map((t, i) => {
                  const s = t.avg || 0;
                  return (
                    <div key={t.id} className="rounded-xl border border-gray-100 p-3">
                      <div className="flex items-center gap-3">
                        <div className="w-7 text-center text-sm font-bold text-gray-400 flex-shrink-0">{medal(i)}</div>
                        <div className="flex-1 min-w-0">
                          <div className="flex justify-between items-baseline gap-2">
                            <span className="font-bold text-sm text-gray-800 truncate">{t.name}{t.motto ? <span className="ml-1 text-[11px] font-normal text-gray-400">· {t.motto}</span> : null}</span>
                            <span className="text-sm font-extrabold text-gray-700 flex-shrink-0">{t.avg ? vsPlan(t.avg) : '—'}</span>
                          </div>
                          <div className="h-2 rounded-full bg-gray-100 overflow-hidden mt-1">
                            <div className={`h-full rounded-full bg-gradient-to-r ${bar(s)} transition-all duration-700`} style={{ width: `${Math.min(100, s)}%` }} />
                          </div>
                        </div>
                      </div>
                      <div className="mt-2 pl-10 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1">
                        {t.members.map((m, mi) => {
                          const champ = mi < 3 && m.score > 0;
                          return (
                            <div key={m.user_id} className={`flex justify-between items-center gap-2 text-xs ${champ ? 'font-semibold' : ''}`}>
                              <span className="flex items-center gap-1.5 min-w-0">
                                <span className="w-4 text-center flex-shrink-0 text-[11px]">{champ ? medal(mi) : <span className="text-gray-300">{mi + 1}</span>}</span>
                                <span className={`truncate ${champ ? 'text-gray-800' : 'text-gray-600'}`}>{m.name}</span>
                              </span>
                              <span className={`flex-shrink-0 ${m.score != null ? (champ ? 'text-emerald-600' : 'text-gray-700') : 'text-gray-300'}`}>{m.score != null ? vsPlan(m.score) : '—'}</span>
                            </div>
                          );
                        })}
                        {t.members.length === 0 && <div className="text-[11px] text-gray-300">No members yet</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2.5">
                {top.map((u, i) => {
                  const raw = Math.max(0, Math.round(u.score || 0));
                  const s = Math.min(100, raw);
                  return (
                    <div key={u.user_id} className="flex items-center gap-3">
                      <div className="w-6 text-center text-sm font-bold text-gray-400">{medal(i)}</div>
                      <div className={`w-8 h-8 rounded-full ${av[i % av.length]} text-white flex items-center justify-center text-xs font-bold flex-shrink-0`}>{(u.name || '?').charAt(0).toUpperCase()}</div>
                      <div className="flex-1 min-w-0">
                        <div className="flex justify-between items-baseline gap-2">
                          <span className="font-semibold text-sm text-gray-800 truncate">{u.name}</span>
                          <span className="text-sm font-bold text-gray-700 flex-shrink-0">{vsPlan(raw)}</span>
                        </div>
                        <div className="h-2 rounded-full bg-gray-100 overflow-hidden mt-1">
                          <div className={`h-full rounded-full bg-gradient-to-r ${bar(s)} transition-all duration-700`} style={{ width: `${Math.min(100, s)}%` }} />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="px-4 pb-3 pt-1 flex justify-between items-center border-t border-gray-50">
              <span className="text-[11px] text-gray-400">Updates automatically as work is logged in the SOTYN.AI — no manual entry.</span>
              <Link to="/scorecard" className="text-xs text-indigo-600 hover:underline font-semibold whitespace-nowrap">Full Scorecard →</Link>
            </div>
          </div>
        );
      })()}

      {/* This Month's Attendance — hidden for admin (they don't personally
          punch in/out; they monitor everyone via the Attendance page). Only
          regular users see this card so the "absent" count reflects actual
          missed punches. */}
      {!isAdmin() && myAttendance && (() => {
        const { days, summary, month } = myAttendance;
        const [yr, mo] = month.split('-');
        const monthLabel = new Date(+yr, +mo - 1, 1).toLocaleString('en-IN', { month: 'long', year: 'numeric' });
        // Status → style for the day cells
        const cellStyle = (s) => {
          if (s === 'present') return 'bg-emerald-100 text-emerald-800';
          if (s === 'late') return 'bg-amber-100 text-amber-800';
          if (s === 'half_day') return 'bg-amber-50 text-amber-700 border border-amber-300';
          if (s === 'short_day') return 'bg-orange-100 text-orange-800';
          if (s === 'on_leave') return 'bg-blue-100 text-blue-700';
          if (s === 'absent') return 'bg-red-100 text-red-700';
          if (s === 'weekend') return 'bg-gray-100 text-gray-400';
          if (s === 'future') return 'bg-white text-gray-300 border border-gray-100';
          return 'bg-white text-gray-400';
        };
        // Prepend blank cells to align first day with its weekday column
        const firstDow = days.length ? days[0].dow : 0;
        const leadingBlanks = Array.from({ length: firstDow }, (_, i) => <div key={'b' + i} />);
        return (
          <div className="card">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 mb-3">
              <h3 className="font-semibold text-gray-800 flex items-center gap-2"><FiCheckSquare className="text-red-600" /> My Attendance — {monthLabel}</h3>
              <Link to="/attendance" className="text-xs text-red-600 hover:underline">Open Attendance →</Link>
            </div>
            {/* Summary strip */}
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mb-3 text-center text-xs">
              <div className="bg-emerald-50 rounded p-2"><div className="font-bold text-emerald-700 text-lg">{summary.present}</div><div className="text-emerald-600">Present</div></div>
              <div className="bg-amber-50 rounded p-2"><div className="font-bold text-amber-700 text-lg">{summary.late}</div><div className="text-amber-600">Late</div></div>
              <div className="bg-orange-50 rounded p-2">
                <div className="font-bold text-orange-700 text-lg">
                  {summary.half_day + summary.short_day}
                  {summary.short_leave_count > 0 && (
                    <span className="text-[10px] font-normal text-orange-600 ml-1">+{summary.short_leave_count}sl</span>
                  )}
                </div>
                <div className="text-orange-600">Half/Short {summary.short_leave_hours > 0 && <span className="text-[9px]">({summary.short_leave_hours}h)</span>}</div>
              </div>
              <div className="bg-blue-50 rounded p-2"><div className="font-bold text-blue-700 text-lg">{summary.on_leave}</div><div className="text-blue-600">On Leave</div></div>
              <div className="bg-red-50 rounded p-2"><div className="font-bold text-red-700 text-lg">{summary.absent}</div><div className="text-red-600">Absent</div></div>
              <div className="bg-gray-50 rounded p-2"><div className="font-bold text-gray-700 text-lg">{summary.total_hours}</div><div className="text-gray-600">Total Hrs</div></div>
            </div>
            {/* Mini calendar — Sun..Sat header then 7-col day grid */}
            <div className="grid grid-cols-7 gap-1 text-center">
              {['S','M','T','W','T','F','S'].map((d, i) => (
                <div key={'h' + i} className="text-[10px] font-bold text-gray-400 uppercase py-1">{d}</div>
              ))}
              {leadingBlanks}
              {days.map(d => (
                <div key={d.date} title={`${d.date} · ${d.status.replace('_', ' ')}`}
                  className={`text-[11px] font-semibold rounded py-2 min-h-[32px] flex items-center justify-center ${cellStyle(d.status)}`}>
                  {d.day}
                </div>
              ))}
            </div>
            <p className="text-[10px] text-gray-400 mt-2 text-center">
              Hover a date to see its status. Green = Present · Amber = Late · Blue = Leave · Red = Absent · Grey = Weekend / Future
            </p>
          </div>
        );
      })()}

      <DashboardHelpTickets />
      {canView('snags') && <DashboardHelpTickets snags />}

      <DashboardAssignments />
      <DashboardAssignments checklists />
      <DashboardRaci />
    </div>
  );
}
