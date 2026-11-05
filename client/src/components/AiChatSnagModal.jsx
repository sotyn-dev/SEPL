import { useState, useEffect } from 'react';
import api from '../api';
import toast from 'react-hot-toast';
import Modal from './Modal';
import { 
  FiCpu, FiMessageSquare, FiClipboard, FiCheckSquare, FiSquare, 
  FiAlertTriangle, FiCheck, FiX, FiRefreshCw, FiLayers, FiMapPin,
  FiUser, FiSend, FiFileText
} from 'react-icons/fi';

const TRADES = ['Civil', 'Electrical', 'Plumbing', 'HVAC', 'Fire Fighting', 'Solar', 'Finishing', 'General'];
const PRIORITIES = [
  { id: 'urgent', label: 'Urgent', color: 'bg-rose-100 text-rose-800 border-rose-300' },
  { id: 'high', label: 'High', color: 'bg-amber-100 text-amber-800 border-amber-300' },
  { id: 'medium', label: 'Medium', color: 'bg-blue-100 text-blue-800 border-blue-300' },
  { id: 'low', label: 'Low', color: 'bg-gray-100 text-gray-700 border-gray-300' }
];

export default function AiChatSnagModal({ isOpen, onClose, defaultTarget = 'snag', onSuccess }) {
  const [activeTab, setActiveTab] = useState('group'); // 'group' | 'paste'
  const [chatGroups, setChatGroups] = useState([]);
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [rawText, setRawText] = useState('');
  const [sites, setSites] = useState([]);
  const [selectedSiteId, setSelectedSiteId] = useState('');
  const [users, setUsers] = useState([]);
  
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [candidates, setCandidates] = useState([]);
  const [hasExtracted, setHasExtracted] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    // Load chat groups
    api.get('/ai-agent/chat-groups')
      .then(r => setChatGroups(Array.isArray(r.data) ? r.data : []))
      .catch(() => setChatGroups([]));

    // Load sites
    api.get('/sites')
      .then(r => {
        const sList = Array.isArray(r.data) ? r.data : (r.data?.sites || []);
        setSites(sList);
        if (sList.length > 0 && !selectedSiteId) {
          setSelectedSiteId(sList[0].id);
        }
      })
      .catch(() => setSites([]));

    // Load active users
    api.get('/users')
      .then(r => setUsers(Array.isArray(r.data) ? r.data : []))
      .catch(() => setUsers([]));
  }, [isOpen]);

  const handleExtract = async () => {
    if (activeTab === 'group' && !selectedGroupId) {
      toast.error('Please select a client chat group');
      return;
    }
    if (activeTab === 'paste' && !rawText.trim()) {
      toast.error('Please paste chat messages or transcript');
      return;
    }

    setLoading(true);
    try {
      const payload = {
        group_id: activeTab === 'group' ? selectedGroupId : undefined,
        chat_text: activeTab === 'paste' ? rawText : undefined,
        site_id: selectedSiteId ? +selectedSiteId : undefined
      };

      const res = await api.post('/ai-agent/extract-snags', payload);
      const items = res.data?.candidates || [];
      if (items.length === 0) {
        toast.error('No punch-list defects or tasks detected in this conversation.');
      } else {
        // Apply defaultTarget if specified by caller
        const formatted = items.map(it => ({
          ...it,
          target_type: defaultTarget === 'pms_task' ? 'pms_task' : (it.target_type || defaultTarget),
          site_id: it.site_id || selectedSiteId || (sites[0]?.id || null)
        }));
        setCandidates(formatted);
        setHasExtracted(true);
        toast.success(`🎯 Extracted ${items.length} actionable items from chat!`);
      }
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to extract items with AI');
    } finally {
      setLoading(false);
    }
  };

  const toggleSelectAll = (checked) => {
    setCandidates(prev => prev.map(c => ({ ...c, selected: checked })));
  };

  const updateCandidate = (index, field, value) => {
    setCandidates(prev => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      if (field === 'site_id') {
        const found = sites.find(s => String(s.id) === String(value));
        next[index].site_name = found?.name || '';
      }
      return next;
    });
  };

  const removeCandidate = (index) => {
    setCandidates(prev => prev.filter((_, i) => i !== index));
  };

  const handleCreateSelected = async () => {
    const selected = candidates.filter(c => c.selected);
    if (selected.length === 0) {
      toast.error('Please select at least one item to create');
      return;
    }

    setSubmitting(true);
    let createdSnagsCount = 0;
    let createdPmsCount = 0;

    try {
      // 1. Separate into snags vs pms_tasks
      const snagItems = selected.filter(c => c.target_type === 'snag');
      const pmsItems = selected.filter(c => c.target_type === 'pms_task');

      // 2. Submit snags batch
      if (snagItems.length > 0) {
        const snagRes = await api.post('/snags/batch', {
          items: snagItems.map(s => ({
            description: s.title ? `${s.title}: ${s.description}` : s.description,
            site_id: s.site_id,
            site_name: s.site_name,
            location: s.location,
            priority: s.priority,
            trade: s.trade,
            assigned_to: s.assigned_to || null,
            target_date: s.target_date || null
          }))
        });
        createdSnagsCount = snagRes.data?.created?.length || snagItems.length;
      }

      // 3. Submit PMS tasks batch
      if (pmsItems.length > 0) {
        const pmsRes = await api.post('/pms-tasks/batch', {
          tasks: pmsItems.map(p => ({
            title: p.title,
            description: `${p.description}\nTrade: ${p.trade || 'General'}\nLocation: ${p.location || 'Site'}\nAction: ${p.suggested_action || 'Pending follow-up'}`,
            site_name: p.site_name || 'General Site',
            assigned_to: p.assigned_to || null,
            due_date: p.due_date || null,
            flow_number: '15.1'
          }))
        });
        createdPmsCount = pmsRes.data?.created?.length || pmsItems.length;
      }

      toast.success(`🎉 Successfully created ${createdSnagsCount} Snag(s) and ${createdPmsCount} PMS Task(s)!`);
      setCandidates([]);
      setHasExtracted(false);
      try {
        if (onSuccess) onSuccess();
      } catch (cbErr) {
        console.warn('[AiChatSnagModal] callback error:', cbErr);
      }
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to create selected tasks');
    } finally {
      setSubmitting(false);
    }
  };

  const selectedCount = candidates.filter(c => c.selected).length;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={
        <div className="flex items-center gap-2">
          <span className="p-1.5 rounded-lg bg-indigo-100 text-indigo-700">
            <FiCpu size={18} />
          </span>
          <div>
            <div className="font-bold text-base text-gray-900">AI Agent: Extract Client Chat Snags & Tasks</div>
            <div className="text-xs text-gray-500 font-normal">TSK-0567 · Instant punch-list & task conversion from client group chats</div>
          </div>
        </div>
      }
      xwide
      zIndex="z-[75]"
    >
      <div className="space-y-4 max-h-[80vh] flex flex-col">
        {/* Source Configuration Section */}
        <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-3 shrink-0">
          <div className="flex items-center justify-between border-b border-slate-200 pb-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setActiveTab('group')}
                className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition flex items-center gap-1.5 ${
                  activeTab === 'group'
                    ? 'bg-indigo-600 text-white shadow-xs'
                    : 'bg-white text-gray-600 border border-gray-300 hover:bg-gray-100'
                }`}
              >
                <FiMessageSquare size={14} /> Group Chat Feed
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('paste')}
                className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition flex items-center gap-1.5 ${
                  activeTab === 'paste'
                    ? 'bg-indigo-600 text-white shadow-xs'
                    : 'bg-white text-gray-600 border border-gray-300 hover:bg-gray-100'
                }`}
              >
                <FiClipboard size={14} /> Paste WhatsApp / Chat Text
              </button>
            </div>

            {/* Default Site Picker */}
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium text-gray-600 flex items-center gap-1">
                <FiMapPin size={12} className="text-gray-400" /> Default Site:
              </label>
              <select
                className="select select-sm text-xs py-1 h-8 bg-white"
                value={selectedSiteId}
                onChange={e => setSelectedSiteId(e.target.value)}
              >
                <option value="">— Pick Site —</option>
                {sites.map(s => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
          </div>

          {activeTab === 'group' ? (
            <div className="space-y-2">
              <label className="text-xs font-semibold text-gray-700 block">
                Select Client / Site Chat Group
              </label>
              <select
                className="select w-full text-sm bg-white"
                value={selectedGroupId}
                onChange={e => setSelectedGroupId(e.target.value)}
              >
                <option value="">— Choose a group from Site Chat ({chatGroups.length} available) —</option>
                {chatGroups.map(g => (
                  <option key={g.id} value={g.id}>
                    {g.name} {g.is_dm ? '(Direct Chat)' : `(${g.message_count || 0} messages)`}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-gray-500">
                AI will inspect the latest messages from this client channel to detect defects, missing items, and punch-list remarks.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              <label className="text-xs font-semibold text-gray-700 block">
                Paste WhatsApp / Client Email Transcript
              </label>
              <textarea
                className="textarea w-full text-xs font-mono bg-white h-24"
                placeholder="[10:15 am, 04/11/2026] Client: Water leakage in AHU room 3rd floor. Please check urgently.&#10;[11:00 am, 04/11/2026] Client: Also lift lobby 2nd floor tiles are cracked..."
                value={rawText}
                onChange={e => setRawText(e.target.value)}
              />
            </div>
          )}

          <div className="flex justify-end pt-1">
            <button
              type="button"
              onClick={handleExtract}
              disabled={loading}
              className="btn bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold px-4 py-2 flex items-center gap-1.5 shadow"
            >
              {loading ? (
                <>
                  <FiRefreshCw size={14} className="animate-spin" /> Analyzing with AI Agent...
                </>
              ) : (
                <>
                  <FiCpu size={14} /> ✨ Extract Actionable Items with AI
                </>
              )}
            </button>
          </div>
        </div>

        {/* Results Candidate Grid */}
        {hasExtracted && (
          <div className="space-y-2 flex-1 overflow-y-auto">
            <div className="flex items-center justify-between px-1 py-1">
              <div className="flex items-center gap-2">
                <span className="font-bold text-sm text-gray-800">
                  Extracted Candidates ({candidates.length})
                </span>
                <span className="text-xs text-indigo-600 bg-indigo-50 border border-indigo-200 px-2 py-0.5 rounded-full font-medium">
                  {candidates.filter(c => c.target_type === 'snag').length} Snag(s) · {candidates.filter(c => c.target_type === 'pms_task').length} PMS Task(s)
                </span>
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => toggleSelectAll(selectedCount !== candidates.length)}
                  className="text-xs text-blue-600 hover:underline font-medium"
                >
                  {selectedCount === candidates.length ? 'Deselect All' : 'Select All'}
                </button>
              </div>
            </div>

            <div className="space-y-2 max-h-[360px] overflow-y-auto pr-1">
              {candidates.map((c, idx) => (
                <div
                  key={c.temp_id || idx}
                  className={`p-3 rounded-xl border transition ${
                    c.selected ? 'bg-white border-indigo-200 shadow-xs' : 'bg-gray-50 border-gray-200 opacity-60'
                  }`}
                >
                  <div className="flex items-start gap-2.5">
                    {/* Checkbox */}
                    <input
                      type="checkbox"
                      checked={Boolean(c.selected)}
                      onChange={e => updateCandidate(idx, 'selected', e.target.checked)}
                      className="mt-1 h-4 w-4 rounded text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                    />

                    {/* Main item details */}
                    <div className="flex-1 space-y-2 min-w-0">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        {/* Title input */}
                        <input
                          type="text"
                          value={c.title || ''}
                          onChange={e => updateCandidate(idx, 'title', e.target.value)}
                          placeholder="Defect title..."
                          className="font-bold text-sm text-gray-900 border-0 border-b border-transparent hover:border-gray-300 focus:border-indigo-500 focus:ring-0 bg-transparent px-1 py-0.5 flex-1 min-w-[200px]"
                        />

                        {/* Destination toggle */}
                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            onClick={() => updateCandidate(idx, 'target_type', 'snag')}
                            className={`px-2 py-0.5 rounded text-[11px] font-bold border transition ${
                              c.target_type === 'snag'
                                ? 'bg-amber-100 text-amber-800 border-amber-300 shadow-2xs'
                                : 'bg-gray-100 text-gray-500 border-gray-200 hover:bg-gray-200'
                            }`}
                          >
                            🚧 Snag List
                          </button>
                          <button
                            type="button"
                            onClick={() => updateCandidate(idx, 'target_type', 'pms_task')}
                            className={`px-2 py-0.5 rounded text-[11px] font-bold border transition ${
                              c.target_type === 'pms_task'
                                ? 'bg-blue-100 text-blue-800 border-blue-300 shadow-2xs'
                                : 'bg-gray-100 text-gray-500 border-gray-200 hover:bg-gray-200'
                            }`}
                          >
                            📌 PMS Task
                          </button>
                        </div>
                      </div>

                      {/* Description textarea */}
                      <textarea
                        value={c.description || ''}
                        onChange={e => updateCandidate(idx, 'description', e.target.value)}
                        placeholder="Detailed observation notes..."
                        className="w-full text-xs text-gray-700 bg-gray-50 border border-gray-200 rounded-md p-1.5 focus:bg-white focus:ring-1 focus:ring-indigo-500"
                        rows={2}
                      />

                      {/* Fields row */}
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1">
                        {/* Site */}
                        <div>
                          <label className="text-[10px] font-bold text-gray-500 uppercase block mb-0.5">Site</label>
                          <select
                            value={c.site_id || ''}
                            onChange={e => updateCandidate(idx, 'site_id', +e.target.value)}
                            className="select select-xs text-[11px] w-full bg-white h-7 py-0"
                          >
                            <option value="">— No site —</option>
                            {sites.map(s => (
                              <option key={s.id} value={s.id}>{s.name}</option>
                            ))}
                          </select>
                        </div>

                        {/* Location */}
                        <div>
                          <label className="text-[10px] font-bold text-gray-500 uppercase block mb-0.5">Location</label>
                          <input
                            type="text"
                            value={c.location || ''}
                            onChange={e => updateCandidate(idx, 'location', e.target.value)}
                            placeholder="e.g. 2nd Floor"
                            className="input input-xs text-[11px] w-full bg-white h-7"
                          />
                        </div>

                        {/* Trade */}
                        <div>
                          <label className="text-[10px] font-bold text-gray-500 uppercase block mb-0.5">Trade</label>
                          <select
                            value={c.trade || 'General'}
                            onChange={e => updateCandidate(idx, 'trade', e.target.value)}
                            className="select select-xs text-[11px] w-full bg-white h-7 py-0"
                          >
                            {TRADES.map(t => (
                              <option key={t} value={t}>{t}</option>
                            ))}
                          </select>
                        </div>

                        {/* Priority */}
                        <div>
                          <label className="text-[10px] font-bold text-gray-500 uppercase block mb-0.5">Priority</label>
                          <select
                            value={c.priority || 'medium'}
                            onChange={e => updateCandidate(idx, 'priority', e.target.value)}
                            className="select select-xs text-[11px] w-full bg-white h-7 py-0 capitalize"
                          >
                            {PRIORITIES.map(p => (
                              <option key={p.id} value={p.id}>{p.label}</option>
                            ))}
                          </select>
                        </div>
                      </div>
                    </div>

                    {/* Delete button */}
                    <button
                      type="button"
                      onClick={() => removeCandidate(idx)}
                      className="text-gray-400 hover:text-red-600 p-1 rounded hover:bg-red-50 transition"
                      title="Discard this candidate"
                    >
                      <FiX size={15} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Modal Footer */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-gray-200 shrink-0">
          <div className="text-xs text-gray-500">
            {hasExtracted ? (
              <span className="font-semibold text-gray-700">
                {selectedCount} of {candidates.length} item(s) selected for creation
              </span>
            ) : (
              <span>Select a group or paste raw text, then click "Extract Actionable Items with AI"</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="btn btn-secondary text-xs px-3 py-1.5"
            >
              Cancel
            </button>
            {hasExtracted && (
              <button
                type="button"
                onClick={handleCreateSelected}
                disabled={submitting || selectedCount === 0}
                className="btn btn-primary text-xs font-bold px-4 py-1.5 flex items-center gap-1.5 shadow"
              >
                {submitting ? (
                  <>
                    <FiRefreshCw size={13} className="animate-spin" /> Creating Tasks...
                  </>
                ) : (
                  <>
                    <FiSend size={13} /> Create {selectedCount} Selected Item{selectedCount === 1 ? '' : 's'}
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

