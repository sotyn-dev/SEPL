import React, { useState, useEffect } from 'react';
import Modal from './Modal';
import api from '../api';
import toast from 'react-hot-toast';
import { fmtDateTime } from '../utils/datetime';
import { FiCopy, FiCheck, FiRefreshCw, FiServer, FiKey, FiActivity, FiHelpCircle } from 'react-icons/fi';

export default function TallySyncModal({ isOpen, onClose, isAdmin }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [copiedToken, setCopiedToken] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  const syncUrl = `${window.location.origin}/api/tally-sync/vouchers`;

  const loadStatus = async () => {
    setLoading(true);
    try {
      const res = await api.get('/tally-sync/status');
      setData(res.data);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to load sync status');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      loadStatus();
    }
  }, [isOpen]);

  const copyToClipboard = (text, type) => {
    navigator.clipboard.writeText(text);
    if (type === 'token') {
      setCopiedToken(true);
      setTimeout(() => setCopiedToken(false), 2000);
      toast.success('API Token copied to clipboard');
    } else {
      setCopiedUrl(true);
      setTimeout(() => setCopiedUrl(false), 2000);
      toast.success('Sync URL copied to clipboard');
    }
  };

  const handleRegenerateToken = async () => {
    if (!confirm('Are you sure you want to regenerate the sync token? You will need to update the token in your Tally agent script.')) {
      return;
    }
    setRegenerating(true);
    try {
      const res = await api.post('/tally-sync/token/regenerate');
      toast.success('New sync token generated');
      setData(prev => ({ ...prev, token: res.data.token }));
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to regenerate token');
    } finally {
      setRegenerating(false);
    }
  };

  if (!isOpen) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Tally to ERP Sync Integration" wide>
      <div className="space-y-5 max-h-[75vh] overflow-y-auto pr-1">
        {loading && !data ? (
          <div className="py-12 text-center text-gray-400">Loading sync status…</div>
        ) : (
          <>
            {/* Quick Metrics */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="card p-3 bg-gradient-to-br from-blue-50 to-white border-blue-100">
                <div className="text-[11px] font-semibold text-blue-700 flex items-center gap-1.5 uppercase">
                  <FiServer /> Total Synced Bills
                </div>
                <div className="text-2xl font-bold text-gray-800 mt-1">
                  {data?.stats?.tally_synced_bills || 0}
                </div>
                <div className="text-[10px] text-gray-500 mt-0.5">
                  out of {data?.stats?.total_bills || 0} total bills
                </div>
              </div>

              <div className="card p-3 bg-gradient-to-br from-emerald-50 to-white border-emerald-100">
                <div className="text-[11px] font-semibold text-emerald-700 flex items-center gap-1.5 uppercase">
                  <FiActivity /> Closed / Paid
                </div>
                <div className="text-2xl font-bold text-emerald-800 mt-1">
                  {data?.stats?.closed_synced_bills || 0}
                </div>
                <div className="text-[10px] text-emerald-600 mt-0.5">
                  Auto-closed via payment vouchers
                </div>
              </div>

              <div className="card p-3 bg-gradient-to-br from-slate-50 to-white border-slate-200">
                <div className="text-[11px] font-semibold text-gray-600 flex items-center gap-1.5 uppercase">
                  <FiRefreshCw /> Last Sync Heartbeat
                </div>
                <div className="text-sm font-bold text-gray-800 mt-1 truncate">
                  {data?.last_sync?.created_at ? fmtDateTime(data.last_sync.created_at) : 'No sync recorded yet'}
                </div>
                <div className="text-[10px] text-gray-500 mt-0.5">
                  {data?.last_sync?.status === 'success' ? (
                    <span className="text-emerald-600 font-semibold">● Operational</span>
                  ) : data?.last_sync ? (
                    <span className="text-red-500 font-semibold">● Last run errored</span>
                  ) : (
                    'Waiting for first sync run'
                  )}
                </div>
              </div>
            </div>

            {/* Connection Credentials */}
            <div className="card p-4 border-slate-200 space-y-3">
              <h4 className="text-xs font-bold text-gray-600 uppercase flex items-center gap-1.5">
                <FiKey /> Agent Connection Configuration
              </h4>
              <p className="text-xs text-gray-500">
                These credentials are used by the local Tally Sync Agent running on your Tally PC to push vouchers securely.
              </p>

              <div>
                <label className="label text-[11px] font-medium text-gray-700">Sync Endpoint URL</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    readOnly
                    value={syncUrl}
                    className="input text-xs font-mono bg-gray-50 text-gray-700 flex-1"
                  />
                  <button
                    onClick={() => copyToClipboard(syncUrl, 'url')}
                    className="btn btn-secondary text-xs flex items-center gap-1 px-3"
                  >
                    {copiedUrl ? <FiCheck className="text-emerald-600" /> : <FiCopy />} Copy
                  </button>
                </div>
              </div>

              <div>
                <label className="label text-[11px] font-medium text-gray-700">Secret Sync Token (X-Tally-Token)</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    readOnly
                    value={data?.token || ''}
                    className="input text-xs font-mono bg-gray-50 text-gray-700 flex-1"
                  />
                  <button
                    onClick={() => copyToClipboard(data?.token, 'token')}
                    className="btn btn-secondary text-xs flex items-center gap-1 px-3"
                  >
                    {copiedToken ? <FiCheck className="text-emerald-600" /> : <FiCopy />} Copy
                  </button>
                  {isAdmin && (
                    <button
                      onClick={handleRegenerateToken}
                      disabled={regenerating}
                      className="btn btn-secondary text-xs text-red-600 hover:text-red-700 flex items-center gap-1 px-2.5"
                      title="Generate a new token"
                    >
                      <FiRefreshCw className={regenerating ? 'animate-spin' : ''} /> Regenerate
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Step-by-Step Instructions */}
            <div className="card p-4 bg-slate-50/70 border-slate-200">
              <h4 className="text-xs font-bold text-gray-700 uppercase flex items-center gap-1.5 mb-2">
                <FiHelpCircle /> Setup on the Tally PC (One-Time)
              </h4>
              <ol className="text-xs text-gray-600 space-y-1.5 list-decimal list-inside">
                <li>
                  <span className="font-semibold text-gray-800">Enable Tally XML Port:</span> In TallyPrime, press <kbd className="px-1 py-0.5 bg-white border rounded text-[10px]">F12</kbd> &rarr; Advanced Configuration &rarr; Set <em>"Tally is acting as"</em> to <strong>Both</strong> and <em>Port</em> to <strong>9000</strong>. Restart Tally.
                </li>
                <li>
                  <span className="font-semibold text-gray-800">Agent Script:</span> Copy the <code>scripts/tally-agent</code> folder to the Main Tally PC (e.g. <code>C:\SEPL-Tally-Sync</code>).
                </li>
                <li>
                  <span className="font-semibold text-gray-800">Run:</span> Set the URL and Token in <code>agent.js</code>, then run <code>node agent.js</code> (or use PM2/Startup shortcut).
                </li>
              </ol>
            </div>

            {/* Recent Logs Table */}
            <div>
              <div className="flex justify-between items-center mb-2">
                <h4 className="text-xs font-bold text-gray-600 uppercase">Recent Sync Logs</h4>
                <button
                  onClick={loadStatus}
                  className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1 font-medium"
                >
                  <FiRefreshCw size={12} /> Refresh
                </button>
              </div>

              <div className="card p-0 overflow-x-auto max-h-48 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50 border-b text-gray-500 sticky top-0">
                    <tr>
                      <th className="py-2 px-3 text-left">Time</th>
                      <th className="py-2 px-3 text-left">Type</th>
                      <th className="py-2 px-3 text-right">Received</th>
                      <th className="py-2 px-3 text-right">Added</th>
                      <th className="py-2 px-3 text-right">Updated</th>
                      <th className="py-2 px-3 text-right">Skipped</th>
                      <th className="py-2 px-3 text-left">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {data?.recent_logs?.length === 0 ? (
                      <tr>
                        <td colSpan="7" className="py-6 text-center text-gray-400">
                          No sync logs yet. Start the agent to initiate sync.
                        </td>
                      </tr>
                    ) : (
                      data?.recent_logs?.map(log => (
                        <tr key={log.id} className="hover:bg-gray-50/50">
                          <td className="py-2 px-3 text-gray-500 whitespace-nowrap">
                            {fmtDateTime(log.created_at)}
                          </td>
                          <td className="py-2 px-3 font-medium capitalize">
                            {log.sync_type}
                          </td>
                          <td className="py-2 px-3 text-right tabular-nums">{log.vouchers_received}</td>
                          <td className="py-2 px-3 text-right tabular-nums text-emerald-600 font-semibold">
                            {log.vouchers_added}
                          </td>
                          <td className="py-2 px-3 text-right tabular-nums text-blue-600">
                            {log.vouchers_updated}
                          </td>
                          <td className="py-2 px-3 text-right tabular-nums text-gray-400">
                            {log.vouchers_skipped}
                          </td>
                          <td className="py-2 px-3">
                            {log.status === 'success' ? (
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
                                Success
                              </span>
                            ) : (
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-red-50 text-red-700 border border-red-200" title={log.error_message}>
                                Error
                              </span>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}

        <div className="flex justify-end pt-2 border-t">
          <button onClick={onClose} className="btn btn-secondary text-sm">
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}
