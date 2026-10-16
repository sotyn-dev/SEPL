import { useState, useEffect, useMemo } from 'react';
import Modal from './Modal';
import api from '../api';
import toast from 'react-hot-toast';
import { FiMail, FiSend, FiCheckCircle, FiAlertCircle, FiInfo, FiSearch, FiRefreshCw, FiEye } from 'react-icons/fi';
import { fmtDateTime } from '../utils/datetime';

const fmtINR = (n) => Math.round(n || 0).toLocaleString('en-IN');

export default function SendSalaryEmailModal({
  isOpen,
  onClose,
  month,
  employees = [],
  isFinalised = false,
  onSuccess,
  currentUser,
  singleTarget = null,
}) {
  const [smtpConfigured, setSmtpConfigured] = useState(true);
  const [checkingSmtp, setCheckingSmtp] = useState(false);

  // Email addresses draft state (keyed by employee_id)
  const [emailMap, setEmailMap] = useState({});
  // Selected employee IDs for bulk send
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [searchQuery, setSearchQuery] = useState('');

  // Test email state
  const [testEmail, setTestEmail] = useState('');
  const [testEmpId, setTestEmpId] = useState('');
  const [sendingTest, setSendingTest] = useState(false);

  // Sending progress & result states
  const [isSending, setIsSending] = useState(false);
  const [sendProgress, setSendProgress] = useState({ current: 0, total: 0 });
  const [sendResult, setSendResult] = useState(null);

  // Single target email
  const [singleEmail, setSingleEmail] = useState('');
  const [singleSending, setSingleSending] = useState(false);

  // Payslip preview state
  const [previewTarget, setPreviewTarget] = useState(null);
  const [previewHtml, setPreviewHtml] = useState(null);
  const [loadingPreview, setLoadingPreview] = useState(false);

  // Check SMTP status and initialize recipient list whenever modal opens
  useEffect(() => {
    if (!isOpen) {
      setSendResult(null);
      setIsSending(false);
      setPreviewTarget(null);
      setPreviewHtml(null);
      return;
    }

    setCheckingSmtp(true);
    api.get('/payroll/email-status')
      .then(res => {
        setSmtpConfigured(!!res.data?.configured);
      })
      .catch(() => {
        setSmtpConfigured(false);
      })
      .finally(() => setCheckingSmtp(false));

    // Prefill test email from logged-in user
    if (currentUser?.email) {
      setTestEmail(currentUser.email);
    }

    if (singleTarget) {
      setSingleEmail(singleTarget.personal_email || '');
    } else {
      // Initialize bulk list with personal emails exclusively
      const initialEmails = {};
      const initialSelected = new Set();
      employees.forEach(emp => {
        const mail = (emp.personal_email || '').trim();
        initialEmails[emp.employee_id] = mail;
        // Preselect employees who have a non-empty personal email
        if (mail.includes('@')) {
          initialSelected.add(emp.employee_id);
        }
      });
      setEmailMap(initialEmails);
      setSelectedIds(initialSelected);
      if (employees.length > 0 && !testEmpId) {
        setTestEmpId(employees[0].employee_id);
      }
    }
  }, [isOpen, singleTarget, employees, currentUser]);

  // Filtered employees for bulk view
  const filteredEmployees = useMemo(() => {
    if (!searchQuery.trim()) return employees;
    const q = searchQuery.toLowerCase().trim();
    return employees.filter(emp =>
      (emp.employee_name && emp.employee_name.toLowerCase().includes(q)) ||
      (emp.department && emp.department.toLowerCase().includes(q)) ||
      (emailMap[emp.employee_id] && emailMap[emp.employee_id].toLowerCase().includes(q))
    );
  }, [employees, searchQuery, emailMap]);

  const toggleSelectAll = () => {
    if (selectedIds.size === filteredEmployees.length && filteredEmployees.length > 0) {
      setSelectedIds(new Set());
    } else {
      const next = new Set(selectedIds);
      filteredEmployees.forEach(e => next.add(e.employee_id));
      setSelectedIds(next);
    }
  };

  const toggleSelectOne = (id) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  };

  const handleEmailChange = (empId, val) => {
    setEmailMap(prev => ({ ...prev, [empId]: val }));
  };

  // Preview payslip HTML directly in modal
  const handleTogglePreview = async (emp) => {
    if (!emp) return;
    if (previewTarget && previewTarget.employee_id === emp.employee_id) {
      setPreviewTarget(null);
      setPreviewHtml(null);
      return;
    }
    setPreviewTarget(emp);
    setLoadingPreview(true);
    try {
      const res = await api.get(`/payroll/preview-slip/${emp.employee_id}?month=${month}`);
      setPreviewHtml(res.data?.html || '<p style="padding:20px;text-align:center;color:#64748b;">No preview available.</p>');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to load salary slip preview');
      setPreviewTarget(null);
      setPreviewHtml(null);
    } finally {
      setLoadingPreview(false);
    }
  };

  // Send single slip (for singleTarget mode)
  const handleSendSingle = async () => {
    const target = singleTarget;
    if (!target) return;
    const emailToUse = (singleEmail || '').trim();
    if (!emailToUse || !emailToUse.includes('@')) {
      toast.error('Please enter a valid email address');
      return;
    }

    setSingleSending(true);
    try {
      const res = await api.post(`/payroll/send-slip/${target.employee_id}`, {
        month,
        email_override: emailToUse,
      });
      toast.success(res.data.message || 'Salary slip sent successfully');
      if (onSuccess) onSuccess();
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to send salary slip email');
    } finally {
      setSingleSending(false);
    }
  };

  // Send test email
  const handleSendTest = async () => {
    const emailToUse = (testEmail || '').trim();
    if (!emailToUse || !emailToUse.includes('@')) {
      toast.error('Enter a valid email address for test delivery');
      return;
    }
    setSendingTest(true);
    try {
      const res = await api.post('/payroll/send-test-slip', {
        month,
        test_email: emailToUse,
        employee_id: testEmpId || (employees[0]?.employee_id),
      });
      toast.success(res.data.message || 'Sample salary slip sent successfully');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to send test email');
    } finally {
      setSendingTest(false);
    }
  };

  // Send bulk slips
  const handleSendBulk = async () => {
    if (selectedIds.size === 0) {
      toast.error('Please select at least one employee');
      return;
    }

    const recipients = [];
    let missingEmailCount = 0;
    employees.forEach(emp => {
      if (selectedIds.has(emp.employee_id)) {
        const mail = (emailMap[emp.employee_id] || '').trim();
        if (!mail || !mail.includes('@')) {
          missingEmailCount++;
        }
        recipients.push({
          employee_id: emp.employee_id,
          email: mail,
        });
      }
    });

    if (missingEmailCount > 0) {
      if (!window.confirm(`${missingEmailCount} selected employee(s) have no valid email entered and will be skipped. Proceed with sending the remaining?`)) {
        return;
      }
    }

    setIsSending(true);
    setSendProgress({ current: 0, total: recipients.length });
    setSendResult(null);

    try {
      const res = await api.post('/payroll/send-bulk-slips', {
        month,
        recipients,
      });
      setSendResult(res.data);
      toast.success(res.data.message || `Salary slips sent successfully`);
      if (onSuccess) onSuccess();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to send bulk salary slips');
    } finally {
      setIsSending(false);
    }
  };

  // Quick single-send from row inside bulk modal
  const handleQuickSend = async (emp) => {
    const mail = (emailMap[emp.employee_id] || '').trim();
    if (!mail || !mail.includes('@')) {
      toast.error(`Please provide a valid email for ${emp.employee_name}`);
      return;
    }
    const tId = toast.loading(`Sending salary slip to ${emp.employee_name}…`);
    try {
      const res = await api.post(`/payroll/send-slip/${emp.employee_id}`, {
        month,
        email_override: mail,
      });
      toast.success(res.data.message || 'Slip sent!', { id: tId });
      if (onSuccess) onSuccess();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to send', { id: tId });
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={isSending ? () => {} : onClose}
      title={
        singleTarget
          ? `Email Salary Slip — ${singleTarget.employee_name} (${month})`
          : `Send Salary Slips via Email (${month})`
      }
      wide={!singleTarget}
    >
      <div className="space-y-4 max-h-[80vh] overflow-y-auto pr-1">
        {/* SMTP Status Alert */}
        {!smtpConfigured && !checkingSmtp && (
          <div className="p-3 bg-amber-50 border border-amber-300 rounded-lg text-amber-800 text-xs flex items-start gap-2.5">
            <FiAlertCircle size={16} className="text-amber-600 shrink-0 mt-0.5" />
            <div>
              <strong>Outgoing SMTP is not configured.</strong>
              <p className="mt-0.5 text-amber-700">
                To deliver salary slips to actual inboxes, please configure your SMTP mail credentials under <strong>Admin → Email Settings</strong>.
              </p>
            </div>
          </div>
        )}

        {/* Unfinalised Warning */}
        {!isFinalised && (
          <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg text-blue-800 text-xs flex items-start gap-2.5">
            <FiInfo size={16} className="text-blue-600 shrink-0 mt-0.5" />
            <div>
              <strong>Payroll is in live / draft mode.</strong>
              <p className="mt-0.5 text-blue-700">
                Salary figures are currently calculated live from open attendance. Finalising the month freezes the figures and records permanent email timestamps.
              </p>
            </div>
          </div>
        )}

        {/* ================= SINGLE EMPLOYEE MODE ================= */}
        {singleTarget ? (
          <div className="space-y-4 py-1">
            {/* Structured Payslip Summary Card */}
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 text-xs space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 pb-2">
                <div>
                  <span className="font-bold text-gray-900 text-sm">{singleTarget.employee_name}</span>
                  <span className="ml-2 text-gray-500">
                    ({singleTarget.department || 'General'}{singleTarget.designation ? ` • ${singleTarget.designation}` : ''})
                  </span>
                </div>
                <div className="text-right">
                  <span className="text-gray-500 text-[10px] uppercase block font-semibold">Agreed Base Salary</span>
                  <span className="font-bold text-gray-800 text-sm">₹{fmtINR(singleTarget.base_salary)}</span>
                </div>
              </div>

              {/* Attendance & Days Accounting Strip */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 bg-white p-2.5 rounded border border-gray-200/80">
                <div>
                  <span className="text-[10px] text-gray-500 uppercase block font-semibold">Calendar Days</span>
                  <span className="font-semibold text-gray-800">{singleTarget.total_days_in_month || 30} days</span>
                </div>
                <div>
                  <span className="text-[10px] text-gray-500 uppercase block font-semibold">Per-Day Rate</span>
                  <span className="font-semibold text-gray-800">₹{fmtINR(singleTarget.per_day_rate)} / day</span>
                </div>
                <div>
                  <span className="text-[10px] text-gray-500 uppercase block font-semibold">Payable Days</span>
                  <span className="font-bold text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded inline-block">
                    {singleTarget.paid_days} of {singleTarget.total_days_in_month || 30} days
                  </span>
                </div>
                <div>
                  <span className="text-[10px] text-gray-500 uppercase block font-semibold">Base Earned</span>
                  <span className="font-bold text-gray-900">
                    ₹{fmtINR(singleTarget.gross_earned || (singleTarget.per_day_rate * singleTarget.paid_days))}
                  </span>
                </div>
              </div>

              {/* Attendance breakdown pills */}
              <div className="text-[11px] text-gray-600 bg-blue-50/60 border border-blue-100 rounded px-2.5 py-1.5 flex flex-wrap gap-x-3 gap-y-1">
                <span><strong>Present:</strong> {singleTarget.present ?? Math.max(0, singleTarget.paid_days - (singleTarget.sunday_count || 0) - (singleTarget.paid_leaves || 0) - (singleTarget.holiday_days || 0))}</span>
                <span><strong>Sundays:</strong> {singleTarget.sunday_count || 0}</span>
                <span><strong>CL / Leaves:</strong> {singleTarget.paid_leaves || 0}</span>
                <span><strong>Holidays:</strong> {singleTarget.holiday_days || 0}</span>
                {singleTarget.half_days > 0 && <span className="text-orange-700"><strong>Half Days:</strong> {singleTarget.half_days} (-{singleTarget.half_days * 0.5}d)</span>}
                {singleTarget.absent_days > 0 && <span className="text-red-700"><strong>Absent (LOP):</strong> {singleTarget.absent_days}</span>}
                {singleTarget.sunday_worked > 0 && <span className="text-emerald-700"><strong>Sunday Worked:</strong> +{singleTarget.sunday_worked_pay}d bonus</span>}
              </div>

              {/* Adjustments: OT, Food, Deductions, Net Pay */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px] pt-1 items-center">
                <div>
                  <span className="text-gray-500 block">Overtime Pay:</span>
                  <span className={singleTarget.ot_pay > 0 ? "font-semibold text-emerald-700" : "text-gray-500"}>
                    {singleTarget.ot_pay > 0 ? `+₹${fmtINR(singleTarget.ot_pay)} (${singleTarget.ot_hours}h)` : '₹0'}
                  </span>
                </div>
                <div>
                  <span className="text-gray-500 block">Food Allowance:</span>
                  <span className={singleTarget.food > 0 ? "font-semibold text-emerald-700" : "text-gray-500"}>
                    {singleTarget.food > 0 ? `+₹${fmtINR(singleTarget.food)}` : '₹0'}
                  </span>
                </div>
                <div>
                  <span className="text-gray-500 block">Deductions:</span>
                  <span className={(singleTarget.late_penalty > 0 || singleTarget.advance > 0) ? "font-semibold text-red-600" : "text-gray-500"}>
                    {(singleTarget.late_penalty > 0 || singleTarget.advance > 0)
                      ? `-₹${fmtINR((singleTarget.late_penalty || 0) + (singleTarget.advance || 0))}`
                      : '₹0'}
                    {singleTarget.late_penalty > 0 && <span className="text-[10px] text-gray-500 font-normal"> (Late: ₹{fmtINR(singleTarget.late_penalty)})</span>}
                    {singleTarget.advance > 0 && <span className="text-[10px] text-gray-500 font-normal"> (Adv: ₹{fmtINR(singleTarget.advance)})</span>}
                  </span>
                </div>
                <div className="sm:text-right">
                  <span className="text-gray-500 block text-[10px] uppercase font-semibold">Net Payable</span>
                  <span className="font-extrabold text-emerald-600 text-base">₹{fmtINR(singleTarget.net_pay)}</span>
                </div>
              </div>
            </div>

            {/* Toggle Preview Button */}
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => handleTogglePreview(singleTarget)}
                className="btn btn-secondary text-xs py-1.5 flex items-center gap-1.5 text-blue-700 border-blue-200 hover:bg-blue-50"
              >
                <FiEye size={13} />
                <span>{previewTarget?.employee_id === singleTarget.employee_id ? 'Hide Payslip Preview' : 'Preview Exact Email Slip'}</span>
              </button>
            </div>

            {/* Preview Frame */}
            {previewTarget?.employee_id === singleTarget.employee_id && (
              <div className="border border-blue-200 rounded-lg overflow-hidden bg-white shadow-xs">
                <div className="bg-blue-50 px-3 py-1.5 text-[11px] font-semibold text-blue-900 border-b border-blue-200 flex justify-between items-center">
                  <span>Exact Email Payslip Preview — {singleTarget.employee_name} ({month})</span>
                  <button type="button" onClick={() => setPreviewTarget(null)} className="text-gray-500 hover:text-gray-800 text-xs">✕ Close</button>
                </div>
                {loadingPreview ? (
                  <div className="p-8 text-center text-gray-400 text-xs">Loading email preview…</div>
                ) : (
                  <iframe
                    title="Payslip Preview"
                    srcDoc={previewHtml}
                    className="w-full h-[460px] border-0"
                  />
                )}
              </div>
            )}

            {singleTarget.email_sent_at && (
              <div className="p-2.5 bg-emerald-50 border border-emerald-200 rounded text-xs text-emerald-800 flex items-center gap-2">
                <FiCheckCircle className="text-emerald-600" size={14} />
                <span>
                  Previously mailed on <strong>{fmtDateTime(singleTarget.email_sent_at)}</strong> to <strong>{singleTarget.email_sent_to || singleTarget.email}</strong>
                </span>
              </div>
            )}

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="label text-xs font-semibold mb-0">Recipient Personal Email *</label>
                {singleTarget.personal_email ? (
                  <span className="text-[11px] text-indigo-700 bg-indigo-50 border border-indigo-200 px-1.5 py-0.5 rounded font-medium">
                    Personal Email
                  </span>
                ) : (
                  <span className="text-[11px] text-rose-700 bg-rose-50 border border-rose-200 px-1.5 py-0.5 rounded font-medium">
                    No Personal Email Configured
                  </span>
                )}
              </div>
              <input
                type="email"
                className="input w-full"
                placeholder="e.g. employee.personal@gmail.com"
                value={singleEmail}
                onChange={e => setSingleEmail(e.target.value)}
                autoFocus
              />
              <p className="text-[11px] text-gray-500 mt-1">
                {singleTarget.personal_email
                  ? 'Prefilled with the employee’s Personal Email from their profile. Slips are sent only to personal emails.'
                  : 'No personal email configured in employee profile. Enter their personal email here or update in Employee Master.'}
              </p>
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t">
              <button
                type="button"
                onClick={onClose}
                disabled={singleSending}
                className="btn btn-secondary text-sm"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSendSingle}
                disabled={singleSending || !singleEmail}
                className="btn btn-primary text-sm flex items-center gap-1.5"
              >
                {singleSending ? <FiRefreshCw className="animate-spin" size={14} /> : <FiSend size={14} />}
                {singleSending ? 'Sending…' : 'Send Salary Slip'}
              </button>
            </div>
          </div>
        ) : (
          /* ================= BULK EMPLOYEES MODE ================= */
          <div className="space-y-4">
            {/* Sample / Test Email Card */}
            <div className="bg-gradient-to-r from-slate-50 to-indigo-50/40 border border-indigo-100 rounded-lg p-3 text-xs">
              <div className="flex items-center gap-1.5 font-semibold text-indigo-900 mb-1.5">
                <FiMail size={13} className="text-indigo-600" />
                <span>Send Test Sample Slip</span>
              </div>
              <p className="text-gray-600 mb-2">
                Send a sample salary slip to your own inbox to preview the layout and formatting before bulk delivery.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="email"
                  className="input text-xs py-1.5 flex-1 min-w-[200px]"
                  placeholder="Enter your email to receive sample slip..."
                  value={testEmail}
                  onChange={e => setTestEmail(e.target.value)}
                />
                <select
                  className="input text-xs py-1.5 min-w-[140px]"
                  value={testEmpId}
                  onChange={e => setTestEmpId(e.target.value)}
                  title="Choose which employee's data to use for the sample"
                >
                  {employees.map(emp => (
                    <option key={emp.employee_id} value={emp.employee_id}>
                      {emp.employee_name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={handleSendTest}
                  disabled={sendingTest || !testEmail}
                  className="btn btn-secondary text-xs py-1.5 flex items-center gap-1 text-indigo-700 border-indigo-200 hover:bg-indigo-100/50"
                >
                  {sendingTest ? <FiRefreshCw className="animate-spin" size={12} /> : <FiSend size={12} />}
                  <span>{sendingTest ? 'Sending Test…' : 'Send Test'}</span>
                </button>
              </div>
            </div>

            {/* Results Report Banner (if just finished sending) */}
            {sendResult && (
              <div className="p-3 bg-emerald-50 border border-emerald-300 rounded-lg text-emerald-900 text-xs space-y-1">
                <div className="flex items-center gap-2 font-bold text-emerald-800">
                  <FiCheckCircle size={15} />
                  <span>Bulk Delivery Completed</span>
                </div>
                <p>
                  <strong>{sendResult.sentCount || 0}</strong> sent successfully,{' '}
                  <strong>{sendResult.skippedCount || 0}</strong> skipped,{' '}
                  <strong>{sendResult.failedCount || 0}</strong> failed.
                </p>
              </div>
            )}

            {/* Payslip Preview Frame in Bulk Mode */}
            {previewTarget && !singleTarget && (
              <div className="border border-indigo-200 rounded-lg overflow-hidden bg-white shadow-xs">
                <div className="bg-indigo-50 px-3 py-2 text-xs font-semibold text-indigo-950 border-b border-indigo-200 flex justify-between items-center">
                  <span>Payslip Preview — {previewTarget.employee_name} ({month})</span>
                  <button
                    type="button"
                    onClick={() => setPreviewTarget(null)}
                    className="text-gray-500 hover:text-gray-800 text-xs px-2 py-0.5 rounded hover:bg-white"
                  >
                    ✕ Close Preview
                  </button>
                </div>
                {loadingPreview ? (
                  <div className="p-8 text-center text-gray-400 text-xs">Loading email preview…</div>
                ) : (
                  <iframe
                    title="Bulk Payslip Preview"
                    srcDoc={previewHtml}
                    className="w-full h-[440px] border-0"
                  />
                )}
              </div>
            )}

            {/* Filter and Select-all bar */}
            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
              <div className="flex items-center gap-2 text-xs">
                <label className="inline-flex items-center gap-1.5 cursor-pointer font-medium text-gray-700">
                  <input
                    type="checkbox"
                    checked={selectedIds.size === filteredEmployees.length && filteredEmployees.length > 0}
                    onChange={toggleSelectAll}
                    disabled={isSending}
                    className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                  />
                  <span>Select All ({selectedIds.size} of {employees.length} selected)</span>
                </label>
              </div>

              <div className="relative min-w-[220px]">
                <FiSearch className="absolute left-2.5 top-2.5 text-gray-400" size={13} />
                <input
                  type="text"
                  placeholder="Filter employees…"
                  className="input text-xs pl-8 py-1.5 w-full"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  disabled={isSending}
                />
              </div>
            </div>

            {/* Employee recipient table */}
            <div className="border border-gray-200 rounded-lg overflow-hidden max-h-[340px] overflow-y-auto">
              <table className="w-full text-xs text-left border-collapse">
                <thead className="bg-gray-50 text-gray-600 sticky top-0 z-10 border-b border-gray-200 font-semibold">
                  <tr>
                    <th className="p-2.5 w-8 text-center"></th>
                    <th className="p-2.5">Employee</th>
                    <th className="p-2.5 text-right w-24">Net Pay</th>
                    <th className="p-2.5">Recipient Email</th>
                    <th className="p-2.5 text-center w-28">Last Mailed</th>
                    <th className="p-2.5 text-center w-16">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filteredEmployees.length === 0 ? (
                    <tr>
                      <td colSpan="6" className="text-center py-6 text-gray-400">
                        No employees found matching filter.
                      </td>
                    </tr>
                  ) : (
                    filteredEmployees.map(emp => {
                      const isSelected = selectedIds.has(emp.employee_id);
                      const currentMail = emailMap[emp.employee_id] || '';
                      const hasValidMail = currentMail.includes('@');

                      return (
                        <tr
                          key={emp.employee_id}
                          className={`hover:bg-gray-50/70 transition-colors ${
                            isSelected ? 'bg-indigo-50/20' : ''
                          }`}
                        >
                          <td className="p-2 text-center">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => toggleSelectOne(emp.employee_id)}
                              disabled={isSending}
                              className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                            />
                          </td>
                          <td className="p-2 font-medium text-gray-900">
                            <div>{emp.employee_name}</div>
                            <div className="text-[10px] text-gray-500 font-normal">
                              {emp.department || 'General'}
                            </div>
                          </td>
                          <td className="p-2 text-right font-bold text-emerald-600 whitespace-nowrap">
                            ₹{fmtINR(emp.net_pay)}
                          </td>
                          <td className="p-2">
                            <div className="flex items-center gap-1.5">
                              <input
                                type="email"
                                value={currentMail}
                                onChange={e => handleEmailChange(emp.employee_id, e.target.value)}
                                placeholder={emp.personal_email ? "Personal email…" : "Enter personal email…"}
                                disabled={isSending}
                                className={`input text-xs py-1 px-2 flex-1 ${
                                  !hasValidMail && isSelected ? 'border-amber-400 bg-amber-50/30' : ''
                                }`}
                              />
                              {emp.personal_email ? (
                                <span className="text-[10px] text-indigo-700 bg-indigo-50 border border-indigo-200 px-1.5 py-0.5 rounded font-medium shrink-0" title="Using Personal Email from employee profile">
                                  Personal
                                </span>
                              ) : (
                                <span className="text-[10px] text-rose-700 bg-rose-50 border border-rose-200 px-1.5 py-0.5 rounded font-medium shrink-0" title="No personal email configured in profile">
                                  No Personal Email
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="p-2 text-center whitespace-nowrap text-[11px]">
                            {emp.email_sent_at ? (
                              <span
                                className="inline-flex items-center gap-1 text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-200"
                                title={`Mailed to ${emp.email_sent_to || currentMail} on ${fmtDateTime(emp.email_sent_at)}`}
                              >
                                <FiCheckCircle size={11} />
                                <span>{fmtDateTime(emp.email_sent_at).slice(0, 11)}</span>
                              </span>
                            ) : (
                              <span className="text-gray-400 text-[10px]">Not sent</span>
                            )}
                          </td>
                          <td className="p-2 text-center whitespace-nowrap">
                            <div className="flex items-center justify-center gap-1">
                              <button
                                type="button"
                                onClick={() => handleTogglePreview(emp)}
                                title="Preview payslip email for this employee"
                                className="btn btn-secondary text-[11px] px-1.5 py-0.5 text-blue-600 hover:bg-blue-50"
                              >
                                <FiEye size={11} />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleQuickSend(emp)}
                                disabled={isSending || !hasValidMail}
                                title="Send slip immediately to this employee"
                                className="btn btn-secondary text-[11px] px-1.5 py-0.5 disabled:opacity-40"
                              >
                                <FiSend size={11} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            {/* Bottom Actions */}
            <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-3 border-t">
              <div className="text-xs text-gray-500">
                {selectedIds.size} of {employees.length} employees selected to receive slips
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  disabled={isSending}
                  className="btn btn-secondary text-sm"
                >
                  Close
                </button>
                <button
                  type="button"
                  onClick={handleSendBulk}
                  disabled={isSending || selectedIds.size === 0}
                  className="btn btn-primary text-sm flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-700"
                >
                  {isSending ? (
                    <>
                      <FiRefreshCw className="animate-spin" size={14} />
                      <span>Sending Slips…</span>
                    </>
                  ) : (
                    <>
                      <FiSend size={14} />
                      <span>Send Selected Slips ({selectedIds.size})</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
