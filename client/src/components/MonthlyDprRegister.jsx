import { useState, useEffect } from 'react';
import api from '../api';
import Modal from './Modal';
import toast from 'react-hot-toast';
import {
  FiCalendar,
  FiUser,
  FiCheckCircle,
  FiXCircle,
  FiCoffee,
  FiDownload,
  FiRefreshCw,
  FiChevronLeft,
  FiChevronRight,
  FiGrid,
  FiList,
  FiEye,
  FiClock,
  FiMapPin
} from 'react-icons/fi';
import { exportCsv } from '../utils/exportCsv';
import { fmtINR } from './EngineerPerformance';

export default function MonthlyDprRegister() {
  const [engineers, setEngineers] = useState([]);
  const [selectedEngId, setSelectedEngId] = useState('');
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState('grid'); // 'grid' | 'table'
  const [selectedDay, setSelectedDay] = useState(null); // for day details modal
  const [selectedDpr, setSelectedDpr] = useState(null); // for DPR inspect modal

  const loadData = (engId = selectedEngId, targetMonth = month) => {
    setLoading(true);
    const params = { month: targetMonth };
    if (engId) params.engineer_id = engId;

    api.get('/dpr/monthly-register', { params })
      .then(r => {
        const res = r.data || {};
        setData(res);
        if (res.engineers?.length) setEngineers(res.engineers);
        if (res.selected_engineer?.id && (!engId || String(engId) !== String(res.selected_engineer.id))) {
          setSelectedEngId(res.selected_engineer.id);
        }
      })
      .catch(err => {
        toast.error(err.response?.data?.error || 'Failed to load monthly register');
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadData(selectedEngId, month);
  }, [selectedEngId, month]);

  // Month navigation helpers
  const shiftMonth = (delta) => {
    const [y, m] = month.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    const newMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    setMonth(newMonth);
  };

  const jumpCurrentMonth = () => {
    const now = new Date();
    const curr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    setMonth(curr);
  };

  // CSV Export
  const handleExportCsv = () => {
    if (!data || !data.days?.length) return;
    const rows = data.days.map(d => ({
      Date: d.date,
      Day: d.day_of_week,
      Status: d.is_submitted
        ? `Submitted (${d.dpr_count})`
        : d.is_future
          ? 'Upcoming'
          : d.is_sunday
            ? 'Sunday (Off)'
            : 'Not Submitted',
      'Attendance Status': d.attendance?.status || 'No record',
      'Punch In': d.attendance?.punch_in_time || '—',
      'Punch Out': d.attendance?.punch_out_time || '—',
      'DPR Count': d.dpr_count,
      'Site(s)': d.dprs.map(x => x.site_name || `Site #${x.site_id}`).join('; ') || '—',
      'DPR IDs': d.dprs.map(x => `#${x.id} (${x.approval_status})`).join('; ') || '—'
    }));

    const engName = (data.selected_engineer?.name || 'Engineer').replace(/[^a-zA-Z0-9]/g, '_');
    exportCsv(`DPR_Monthly_Register_${engName}_${month}.csv`, rows);
  };

  // Calendar padding: calculate leading blanks for 1st day of month (0 = Sun, 1 = Mon...)
  const firstDayWeekday = (() => {
    if (!data?.days?.length) return 0;
    const firstDate = new Date(`${data.days[0].date}T00:00:00`);
    return firstDate.getDay();
  })();

  const summary = data?.summary || {
    total_days: 0,
    submitted_days: 0,
    missing_working_days: 0,
    sundays: 0,
    adherence_rate: 0
  };

  return (
    <div className="space-y-4">
      {/* Top Filter and Controls Strip */}
      <div className="card p-3 sm:p-4 bg-white shadow-xs border border-gray-200 rounded-xl">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
          
          {/* Engineer Selector */}
          <div className="flex items-center gap-2 flex-1 max-w-md">
            <FiUser className="text-gray-400 text-lg shrink-0" />
            <div className="w-full">
              <label className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider block mb-0.5">
                Site Engineer
              </label>
              <select
                value={selectedEngId}
                onChange={e => setSelectedEngId(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-2.5 py-1.5 text-sm bg-white font-medium focus:ring-2 focus:ring-blue-500 focus:outline-hidden"
              >
                {engineers.map(e => (
                  <option key={e.id} value={e.id}>
                    {e.name} {e.role_names ? `(${e.role_names})` : ''}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Month Picker with Quick Prev/Next buttons */}
          <div className="flex items-center gap-1.5">
            <div>
              <label className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider block mb-0.5">
                Month
              </label>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => shiftMonth(-1)}
                  className="p-1.5 border border-gray-300 rounded-lg hover:bg-gray-100 text-gray-600 transition-colors"
                  title="Previous Month"
                >
                  <FiChevronLeft size={16} />
                </button>
                <input
                  type="month"
                  value={month}
                  onChange={e => setMonth(e.target.value)}
                  className="border border-gray-300 rounded-lg px-2.5 py-1.5 text-sm font-semibold text-gray-800 bg-white focus:ring-2 focus:ring-blue-500 focus:outline-hidden"
                />
                <button
                  type="button"
                  onClick={() => shiftMonth(1)}
                  className="p-1.5 border border-gray-300 rounded-lg hover:bg-gray-100 text-gray-600 transition-colors"
                  title="Next Month"
                >
                  <FiChevronRight size={16} />
                </button>
                <button
                  type="button"
                  onClick={jumpCurrentMonth}
                  className="px-2.5 py-1.5 text-xs font-medium border border-gray-300 rounded-lg hover:bg-gray-100 text-gray-700 whitespace-nowrap"
                >
                  Current
                </button>
              </div>
            </div>
          </div>

          {/* View Mode & Export Actions */}
          <div className="flex items-end gap-2 ml-auto">
            <div className="bg-gray-100 p-0.5 rounded-lg flex items-center border border-gray-200">
              <button
                type="button"
                onClick={() => setViewMode('grid')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
                  viewMode === 'grid'
                    ? 'bg-white text-blue-600 shadow-xs'
                    : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                <FiGrid size={14} /> Grid
              </button>
              <button
                type="button"
                onClick={() => setViewMode('table')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
                  viewMode === 'table'
                    ? 'bg-white text-blue-600 shadow-xs'
                    : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                <FiList size={14} /> Table
              </button>
            </div>

            <button
              type="button"
              onClick={handleExportCsv}
              disabled={!data?.days?.length}
              className="btn btn-secondary flex items-center gap-1.5 text-xs py-2 px-3"
              title="Export Month Breakdown to CSV"
            >
              <FiDownload size={14} /> Export CSV
            </button>

            <button
              type="button"
              onClick={() => loadData(selectedEngId, month)}
              className="btn btn-secondary p-2"
              title="Refresh Data"
            >
              <FiRefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>

        {/* Assigned Sites Strip */}
        {data?.assigned_sites?.length > 0 && (
          <div className="mt-3 pt-2.5 border-t border-gray-100 flex items-center gap-2 text-xs text-gray-600 overflow-x-auto">
            <span className="font-semibold text-gray-700 shrink-0 flex items-center gap-1">
              <FiMapPin size={13} className="text-teal-600" /> Assigned Sites ({data.assigned_sites.length}):
            </span>
            <div className="flex gap-1.5 flex-wrap">
              {data.assigned_sites.map(s => (
                <span key={s.id} className="bg-gray-100 text-gray-800 px-2 py-0.5 rounded text-[11px] font-medium border border-gray-200">
                  {s.name}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* KPI Cards Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <div className="card text-center border-l-4 border-blue-500 py-3 bg-white shadow-xs">
          <div className="text-2xl font-black text-blue-600">{summary.total_days}</div>
          <div className="text-xs font-medium text-gray-500 mt-0.5">Total Days</div>
          <div className="text-[10px] text-gray-400">{data?.month_name || month}</div>
        </div>

        <div className="card text-center border-l-4 border-emerald-500 py-3 bg-white shadow-xs">
          <div className="text-2xl font-black text-emerald-600 flex items-center justify-center gap-1">
            <FiCheckCircle size={20} className="text-emerald-500" />
            {summary.submitted_days}
          </div>
          <div className="text-xs font-medium text-emerald-800 mt-0.5">DPR Submitted</div>
          <div className="text-[10px] text-emerald-600 font-semibold">{summary.total_dprs || summary.submitted_days} Reports Filed</div>
        </div>

        <div className="card text-center border-l-4 border-red-500 py-3 bg-white shadow-xs">
          <div className="text-2xl font-black text-red-600 flex items-center justify-center gap-1">
            <FiXCircle size={20} className="text-red-500" />
            {summary.missing_working_days}
          </div>
          <div className="text-xs font-medium text-red-800 mt-0.5">Not Submitted (Working)</div>
          <div className="text-[10px] text-red-500 font-medium">Missed Deadline</div>
        </div>

        <div className="card text-center border-l-4 border-amber-500 py-3 bg-white shadow-xs">
          <div className="text-2xl font-black text-amber-600 flex items-center justify-center gap-1">
            <FiCoffee size={20} className="text-amber-500" />
            {summary.sundays}
          </div>
          <div className="text-xs font-medium text-amber-800 mt-0.5">Sundays (Weekly Off)</div>
          <div className="text-[10px] text-gray-400">Standard Off</div>
        </div>

        <div className="card text-center border-l-4 border-indigo-500 py-3 bg-white shadow-xs col-span-2 sm:col-span-1">
          <div className={`text-2xl font-black ${summary.adherence_rate >= 80 ? 'text-emerald-600' : summary.adherence_rate >= 50 ? 'text-amber-600' : 'text-red-600'}`}>
            {summary.adherence_rate}%
          </div>
          <div className="text-xs font-medium text-gray-600 mt-0.5">Adherence Rate</div>
          <div className="text-[10px] text-gray-400">{summary.submitted_days} of {summary.elapsed_working_days || 0} working days</div>
        </div>
      </div>

      {/* Quick Dates Pill Summaries */}
      <div className="card p-3 bg-white border border-gray-200 rounded-xl space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-bold text-emerald-700 flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 inline-block"></span>
            Submitted Dates ({summary.submitted_dates?.length || 0}):
          </span>
          <div className="flex flex-wrap gap-1">
            {summary.submitted_dates?.length > 0 ? (
              summary.submitted_dates.map(dayNum => (
                <span
                  key={dayNum}
                  onClick={() => {
                    const found = data?.days?.find(d => d.day_number === dayNum);
                    if (found) setSelectedDay(found);
                  }}
                  className="cursor-pointer bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-300 text-[11px] font-bold px-2 py-0.5 rounded-md transition-all shadow-2xs"
                  title={`Click to view DPR details for day ${dayNum}`}
                >
                  {String(dayNum).padStart(2, '0')}
                </span>
              ))
            ) : (
              <span className="text-xs text-gray-400 italic">None submitted this month</span>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-gray-100">
          <span className="text-xs font-bold text-red-700 flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-full bg-red-500 inline-block"></span>
            Missed Dates ({summary.missed_working_dates?.length || 0}):
          </span>
          <div className="flex flex-wrap gap-1">
            {summary.missed_working_dates?.length > 0 ? (
              summary.missed_working_dates.map(dayNum => (
                <span
                  key={dayNum}
                  onClick={() => {
                    const found = data?.days?.find(d => d.day_number === dayNum);
                    if (found) setSelectedDay(found);
                  }}
                  className="cursor-pointer bg-red-50 text-red-700 hover:bg-red-100 border border-red-300 text-[11px] font-bold px-2 py-0.5 rounded-md transition-all shadow-2xs"
                  title={`Click to view attendance info for day ${dayNum}`}
                >
                  {String(dayNum).padStart(2, '0')}
                </span>
              ))
            ) : (
              <span className="text-xs text-emerald-600 font-semibold">100% On Track! No missed dates.</span>
            )}
          </div>
        </div>
      </div>

      {/* Main View Area: Calendar Grid or Table */}
      {loading ? (
        <div className="card text-center py-12 text-gray-400 bg-white border border-gray-200 rounded-xl">
          <FiRefreshCw className="animate-spin text-2xl mx-auto mb-2 text-blue-500" />
          Loading monthly DPR register...
        </div>
      ) : viewMode === 'grid' ? (
        /* Calendar Grid View */
        <div className="card p-3 sm:p-4 bg-white border border-gray-200 rounded-xl shadow-xs">
          {/* Day of Week Headers */}
          <div className="grid grid-cols-7 gap-1 sm:gap-2 text-center font-bold text-xs text-gray-500 uppercase tracking-wider mb-2">
            <div className="text-red-500">Sun</div>
            <div>Mon</div>
            <div>Tue</div>
            <div>Wed</div>
            <div>Thu</div>
            <div>Fri</div>
            <div className="text-blue-600">Sat</div>
          </div>

          {/* Calendar Day Cells */}
          <div className="grid grid-cols-7 gap-1 sm:gap-2">
            {/* Blank cells for offset before 1st of month */}
            {Array.from({ length: firstDayWeekday }).map((_, i) => (
              <div key={`blank-${i}`} className="min-h-[85px] sm:min-h-[105px] bg-gray-50/50 rounded-lg border border-dashed border-gray-200 opacity-40"></div>
            ))}

            {/* Days of Month */}
            {data?.days?.map(day => {
              const isSubmitted = day.is_submitted;
              const isSunday = day.is_sunday;
              const isFuture = day.is_future;
              const isToday = day.is_today;
              const isMissed = !isSubmitted && !isSunday && !isFuture;

              return (
                <div
                  key={day.date}
                  onClick={() => setSelectedDay(day)}
                  className={`min-h-[85px] sm:min-h-[105px] p-1.5 sm:p-2 rounded-xl border transition-all cursor-pointer flex flex-col justify-between relative group ${
                    isSubmitted
                      ? 'bg-emerald-50/70 border-emerald-300 hover:border-emerald-500 hover:shadow-md'
                      : isMissed
                        ? 'bg-red-50/60 border-red-200 hover:border-red-400 hover:shadow-md'
                        : isSunday
                          ? 'bg-amber-50/40 border-amber-200/80 hover:border-amber-300'
                          : 'bg-gray-50/80 border-gray-200 text-gray-400'
                  } ${isToday ? 'ring-2 ring-blue-500 font-bold' : ''}`}
                >
                  {/* Top Bar of Cell */}
                  <div className="flex items-center justify-between">
                    <span className={`text-xs sm:text-sm font-black ${
                      isSubmitted
                        ? 'text-emerald-800'
                        : isMissed
                          ? 'text-red-700'
                          : isSunday
                            ? 'text-amber-800'
                            : 'text-gray-500'
                    }`}>
                      {day.day_number}
                    </span>
                    {isToday && (
                      <span className="bg-blue-600 text-white text-[9px] font-bold px-1.5 py-0.2 rounded-full uppercase">
                        Today
                      </span>
                    )}
                    {isSubmitted && (
                      <span className="bg-emerald-600 text-white text-[9px] font-black px-1.5 py-0.2 rounded-full flex items-center gap-0.5">
                        <FiCheckCircle size={10} /> {day.dpr_count}
                      </span>
                    )}
                  </div>

                  {/* Middle Content */}
                  <div className="my-1 overflow-hidden">
                    {isSubmitted ? (
                      <div className="space-y-0.5">
                        {day.dprs.slice(0, 2).map((dp, idx) => (
                          <div key={idx} className="text-[10px] font-semibold text-emerald-900 truncate bg-emerald-100/70 px-1 py-0.5 rounded" title={dp.site_name}>
                            {dp.site_name || `Site #${dp.site_id}`}
                          </div>
                        ))}
                        {day.dprs.length > 2 && (
                          <div className="text-[9px] text-emerald-700 font-bold">
                            +{day.dprs.length - 2} more
                          </div>
                        )}
                      </div>
                    ) : isMissed ? (
                      <div className="text-center py-1">
                        <span className="inline-block bg-red-100 text-red-700 text-[10px] font-bold px-1.5 py-0.5 rounded">
                          ❌ No DPR
                        </span>
                      </div>
                    ) : isSunday ? (
                      <div className="text-center py-1">
                        <span className="text-[10px] font-medium text-amber-700">
                          ☕ Sunday
                        </span>
                      </div>
                    ) : (
                      <div className="text-center py-1 text-[10px] text-gray-400">
                        Upcoming
                      </div>
                    )}
                  </div>

                  {/* Bottom Strip: Attendance tag */}
                  <div className="text-[9px] pt-1 border-t border-black/5 flex items-center justify-between text-gray-500">
                    <span className="truncate">
                      {day.attendance?.status ? (
                        <span className={`font-semibold ${
                          day.attendance.status === 'present' ? 'text-emerald-700' : 'text-gray-600'
                        }`}>
                          ● {day.attendance.status}
                        </span>
                      ) : (
                        <span className="text-gray-400">No punch</span>
                      )}
                    </span>
                    <FiEye size={11} className="opacity-0 group-hover:opacity-100 text-gray-400 transition-opacity" />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        /* Detailed Table View */
        <div className="card p-0 overflow-hidden bg-white border border-gray-200 rounded-xl shadow-xs">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-gray-50 border-b border-gray-200 text-gray-600 uppercase font-semibold text-[10px] tracking-wider">
                <tr>
                  <th className="px-3 py-2.5">Date</th>
                  <th className="px-3 py-2.5">Day</th>
                  <th className="px-3 py-2.5">DPR Status</th>
                  <th className="px-3 py-2.5">Attendance</th>
                  <th className="px-3 py-2.5">Sites / Projects</th>
                  <th className="px-3 py-2.5">DPR Details</th>
                  <th className="px-3 py-2.5 text-right">Profit / Loss</th>
                  <th className="px-3 py-2.5 text-center">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data?.days?.map(day => {
                  const isSubmitted = day.is_submitted;
                  const isSunday = day.is_sunday;
                  const isFuture = day.is_future;
                  const isMissed = !isSubmitted && !isSunday && !isFuture;

                  return (
                    <tr
                      key={day.date}
                      className={`hover:bg-blue-50/30 transition-colors ${
                        isSubmitted ? 'bg-emerald-50/20' : isMissed ? 'bg-red-50/20' : ''
                      }`}
                    >
                      <td className="px-3 py-2 font-bold text-gray-900 whitespace-nowrap">
                        {day.date}
                        {day.is_today && (
                          <span className="ml-1.5 bg-blue-100 text-blue-700 text-[9px] px-1.5 py-0.2 rounded font-bold">
                            Today
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 font-medium text-gray-600 whitespace-nowrap">
                        {day.day_of_week}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {isSubmitted ? (
                          <span className="inline-flex items-center gap-1 bg-emerald-100 text-emerald-800 text-[11px] font-bold px-2 py-0.5 rounded-full">
                            <FiCheckCircle size={12} /> Submitted ({day.dpr_count})
                          </span>
                        ) : isMissed ? (
                          <span className="inline-flex items-center gap-1 bg-red-100 text-red-800 text-[11px] font-bold px-2 py-0.5 rounded-full">
                            <FiXCircle size={12} /> NOT Submitted
                          </span>
                        ) : isSunday ? (
                          <span className="inline-flex items-center gap-1 bg-amber-100 text-amber-800 text-[11px] font-medium px-2 py-0.5 rounded-full">
                            <FiCoffee size={12} /> Sunday (Off)
                          </span>
                        ) : (
                          <span className="text-gray-400 text-[11px]">Upcoming</span>
                        )}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {day.attendance?.status ? (
                          <span className={`font-semibold capitalize ${
                            day.attendance.status === 'present' ? 'text-emerald-700' : 'text-gray-600'
                          }`}>
                            {day.attendance.status}
                            {day.attendance.total_hours ? ` (${day.attendance.total_hours}h)` : ''}
                          </span>
                        ) : (
                          <span className="text-gray-400 italic">No record</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {isSubmitted ? (
                          <div className="space-y-0.5">
                            {day.dprs.map((dp, i) => (
                              <div key={i} className="font-semibold text-gray-800">
                                {dp.site_name || `Site #${dp.site_id}`}
                              </div>
                            ))}
                          </div>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {isSubmitted ? (
                          <div className="flex flex-wrap gap-1">
                            {day.dprs.map(dp => (
                              <button
                                key={dp.id}
                                type="button"
                                onClick={() => setSelectedDpr(dp)}
                                className="bg-gray-100 hover:bg-gray-200 text-gray-800 text-[11px] font-medium px-2 py-0.5 rounded border border-gray-300"
                              >
                                DPR #{dp.id} ({dp.approval_status})
                              </button>
                            ))}
                          </div>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        {isSubmitted ? (
                          (() => {
                            const pl = day.dprs.reduce((acc, x) => acc + Number(x.profit_loss || 0), 0);
                            return (
                              <span className={`font-bold ${pl >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                                {fmtINR(pl)}
                              </span>
                            );
                          })()
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-center whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => setSelectedDay(day)}
                          className="btn btn-secondary !py-1 !px-2 text-[11px]"
                          title="View Day Breakdown"
                        >
                          <FiEye size={12} className="inline mr-1" /> View
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Day Details Modal */}
      {selectedDay && (
        <Modal
          isOpen={true}
          onClose={() => setSelectedDay(null)}
          title={`Day Details — ${selectedDay.date} (${selectedDay.day_of_week})`}
          wide
        >
          <div className="space-y-4">
            {/* Engineer & Status banner */}
            <div className={`p-3 rounded-xl border flex items-center justify-between ${
              selectedDay.is_submitted
                ? 'bg-emerald-50 border-emerald-300 text-emerald-900'
                : selectedDay.is_sunday
                  ? 'bg-amber-50 border-amber-300 text-amber-900'
                  : selectedDay.is_future
                    ? 'bg-gray-50 border-gray-300 text-gray-700'
                    : 'bg-red-50 border-red-300 text-red-900'
            }`}>
              <div>
                <div className="text-xs font-semibold text-gray-500 uppercase">Engineer</div>
                <div className="font-bold text-sm">{data?.selected_engineer?.name} ({data?.selected_engineer?.email})</div>
              </div>
              <div className="text-right">
                <div className="text-xs font-semibold text-gray-500 uppercase">DPR Status</div>
                <div className="font-extrabold text-sm">
                  {selectedDay.is_submitted
                    ? `✅ Submitted (${selectedDay.dpr_count} DPRs)`
                    : selectedDay.is_sunday
                      ? '☕ Sunday (Off)'
                      : selectedDay.is_future
                        ? '⏳ Upcoming'
                        : '❌ NOT Submitted'}
                </div>
              </div>
            </div>

            {/* Attendance section */}
            <div className="bg-gray-50 p-3 rounded-xl border border-gray-200">
              <h4 className="text-xs font-bold uppercase text-gray-600 mb-2 flex items-center gap-1.5">
                <FiClock size={14} /> Attendance Punch Details
              </h4>
              {selectedDay.attendance ? (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                  <div><strong>Status:</strong> <span className="capitalize font-semibold text-emerald-700">{selectedDay.attendance.status}</span></div>
                  <div><strong>Punch In:</strong> {selectedDay.attendance.punch_in_time || '—'}</div>
                  <div><strong>Punch Out:</strong> {selectedDay.attendance.punch_out_time || '—'}</div>
                  <div><strong>Punch Site:</strong> {selectedDay.attendance.site_name || '—'}</div>
                </div>
              ) : (
                <div className="text-xs text-gray-500 italic">No biometric/mobile attendance recorded for this date.</div>
              )}
            </div>

            {/* Submitted DPRs List */}
            <div>
              <h4 className="text-xs font-bold uppercase text-gray-600 mb-2 flex items-center gap-1.5">
                <FiCalendar size={14} /> Submitted Reports ({selectedDay.dprs.length})
              </h4>
              {selectedDay.dprs.length === 0 ? (
                <div className="text-center py-6 text-gray-400 bg-gray-50 rounded-xl border border-dashed text-xs">
                  No DPR was submitted by this engineer on {selectedDay.date}.
                </div>
              ) : (
                <div className="space-y-2">
                  {selectedDay.dprs.map(dp => (
                    <div
                      key={dp.id}
                      className="p-3 bg-white rounded-xl border border-gray-200 hover:border-blue-400 transition-all shadow-2xs flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                    >
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-sm text-gray-900">{dp.site_name || `Site #${dp.site_id}`}</span>
                          <span className="bg-blue-100 text-blue-700 text-[10px] font-bold px-2 py-0.5 rounded-full">
                            DPR #{dp.id}
                          </span>
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full capitalize ${
                            dp.approval_status === 'approved'
                              ? 'bg-emerald-100 text-emerald-800'
                              : dp.approval_status === 'rejected'
                                ? 'bg-red-100 text-red-800'
                                : 'bg-amber-100 text-amber-800'
                          }`}>
                            {dp.approval_status}
                          </span>
                        </div>
                        <div className="text-xs text-gray-500 mt-1">
                          Client: {dp.client_name || '—'} &nbsp;|&nbsp; Submitted at: {dp.submission_time || dp.created_at || '—'}
                        </div>
                      </div>

                      <div className="flex items-center gap-4">
                        <div className="text-right">
                          <div className="text-[11px] text-gray-500">Profit / Loss</div>
                          <div className={`font-black text-sm ${Number(dp.profit_loss || 0) >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                            {fmtINR(dp.profit_loss)}
                          </div>
                        </div>

                        <button
                          type="button"
                          onClick={() => {
                            setSelectedDpr(dp);
                          }}
                          className="btn btn-secondary !py-1.5 !px-3 text-xs"
                        >
                          <FiEye size={13} className="inline mr-1" /> View Full DPR
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex justify-end pt-2">
              <button
                type="button"
                onClick={() => setSelectedDay(null)}
                className="btn btn-secondary"
              >
                Close
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Full DPR Summary Modal */}
      {selectedDpr && (
        <Modal
          isOpen={true}
          onClose={() => setSelectedDpr(null)}
          title={`DPR #${selectedDpr.id} — ${selectedDpr.site_name || 'Site'} (${selectedDpr.report_date})`}
          wide
        >
          <div className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 p-3 bg-gray-50 rounded-xl text-xs">
              <div><strong>Site:</strong> {selectedDpr.site_name}</div>
              <div><strong>Report Date:</strong> {selectedDpr.report_date}</div>
              <div><strong>Status:</strong> <span className="capitalize font-semibold">{selectedDpr.approval_status}</span></div>
              <div><strong>Progress:</strong> <span className="capitalize">{selectedDpr.overall_status || 'On track'}</span></div>
            </div>

            <div className="grid grid-cols-3 gap-3 text-center">
              <div className="p-3 bg-emerald-50 rounded-xl border border-emerald-200">
                <div className="text-xs text-emerald-700 font-semibold uppercase">Table A (Labour Value)</div>
                <div className="text-base font-bold text-emerald-800 mt-1">{fmtINR(selectedDpr.grand_total_a)}</div>
              </div>
              <div className="p-3 bg-red-50 rounded-xl border border-red-200">
                <div className="text-xs text-red-700 font-semibold uppercase">Table B (Labour Cost)</div>
                <div className="text-base font-bold text-red-800 mt-1">{fmtINR(selectedDpr.grand_total_b)}</div>
              </div>
              <div className={`p-3 rounded-xl border ${Number(selectedDpr.profit_loss || 0) >= 0 ? 'bg-emerald-100/60 border-emerald-300' : 'bg-red-100/60 border-red-300'}`}>
                <div className="text-xs font-semibold uppercase">Profit / Loss</div>
                <div className={`text-base font-black mt-1 ${Number(selectedDpr.profit_loss || 0) >= 0 ? 'text-emerald-800' : 'text-red-700'}`}>
                  {fmtINR(selectedDpr.profit_loss)}
                </div>
              </div>
            </div>

            {selectedDpr.contractor_name && (
              <div className="p-3 bg-gray-50 rounded-xl text-xs">
                <strong>Contractor:</strong> {selectedDpr.contractor_name} &nbsp;|&nbsp; <strong>Manpower:</strong> {selectedDpr.contractor_manpower || 0}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setSelectedDpr(null)}
                className="btn btn-secondary"
              >
                Close
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

