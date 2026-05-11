import { useState, useRef, useEffect } from 'react';
import api from '../api';
import { FiMessageCircle, FiX, FiSend, FiAlertCircle } from 'react-icons/fi';

// Floating chat bubble + expandable panel. Renders on every page via
// Layout.jsx. Hidden entirely if the API key isn't configured (so
// non-admin users don't see a broken feature).
//
// Chat is stateless on the server — we keep the last ~10 turns in
// client state and send them as `history` on each /ask call so Claude
// has context for follow-up questions.
export default function AIAgentChat() {
  const [open, setOpen] = useState(false);
  const [configured, setConfigured] = useState(null); // null = unknown
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState([]); // { role, content, sql_runs? }
  const scrollRef = useRef(null);
  const inputRef = useRef(null);

  // Poll status on mount + when opening (so admin enabling it shows up
  // without a full page reload).
  useEffect(() => {
    let cancelled = false;
    api.get('/ai-agent/status').then(r => { if (!cancelled) setConfigured(!!r.data.configured); })
      .catch(() => { if (!cancelled) setConfigured(false); });
    return () => { cancelled = true; };
  }, [open]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, busy]);

  useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus();
  }, [open]);

  // Hide the bubble entirely until we know the chatbot is configured.
  // This keeps the UI clean before mam pastes her API key, and avoids
  // every user seeing a "Not configured" error on first click.
  if (configured === null || configured === false) return null;

  const send = async () => {
    const q = input.trim();
    if (!q || busy) return;
    const next = [...messages, { role: 'user', content: q }];
    setMessages(next);
    setInput('');
    setBusy(true);
    try {
      const history = messages.slice(-10).map(m => ({ role: m.role, content: m.content }));
      const { data } = await api.post('/ai-agent/ask', { question: q, history });
      setMessages([...next, { role: 'assistant', content: data.answer || '(no answer)', sql_runs: data.sql_runs || [] }]);
    } catch (err) {
      const msg = err.response?.data?.error || err.message || 'Request failed';
      setMessages([...next, { role: 'assistant', content: `⚠️ ${msg}`, error: true }]);
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  return (
    <>
      {/* Bubble — bottom-right. The Help & Support button uses bottom-6 right-6,
          so we sit just above it. */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          title="Ask ERP — AI Assistant"
          className="fixed bottom-24 right-6 z-30 w-14 h-14 rounded-full bg-gradient-to-br from-red-700 to-red-900 text-white shadow-xl shadow-red-900/40 flex items-center justify-center hover:scale-110 transition-transform"
        >
          <FiMessageCircle size={22} />
        </button>
      )}

      {open && (
        <div className="fixed bottom-6 right-6 z-40 w-[min(90vw,400px)] h-[min(80vh,560px)] bg-white border border-gray-200 rounded-2xl shadow-2xl flex flex-col overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 bg-gradient-to-r from-red-700 to-red-900 text-white">
            <div>
              <div className="font-semibold text-sm">Ask ERP</div>
              <div className="text-[10px] text-red-100 -mt-0.5">AI assistant · reads your data</div>
            </div>
            <button onClick={() => setOpen(false)} className="hover:bg-white/10 rounded p-1"><FiX size={18} /></button>
          </div>

          <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-3 bg-gray-50">
            {messages.length === 0 && (
              <div className="text-xs text-gray-500 space-y-2">
                <p className="font-medium text-gray-700">Try asking:</p>
                <div className="grid gap-1.5">
                  {[
                    'What rate did we give L&T for 1.5T AC last time?',
                    'Which customers haven\'t paid in 60 days?',
                    'Top 5 items by quote volume this quarter',
                    'Today\'s DPR submissions by site',
                  ].map((s, i) => (
                    <button key={i} onClick={() => setInput(s)}
                      className="text-left bg-white border border-gray-200 hover:border-red-300 hover:bg-red-50 rounded px-2 py-1.5 text-xs text-gray-700">
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
                  m.role === 'user'
                    ? 'bg-red-700 text-white'
                    : m.error
                      ? 'bg-yellow-50 text-yellow-900 border border-yellow-200'
                      : 'bg-white border border-gray-200 text-gray-800'
                }`}>
                  {m.error && <FiAlertCircle className="inline mr-1 -mt-0.5" size={14} />}
                  {m.content}
                  {m.sql_runs?.length > 0 && (
                    <details className="mt-2 text-[10px] text-gray-500">
                      <summary className="cursor-pointer hover:text-gray-700">
                        {m.sql_runs.length} {m.sql_runs.length === 1 ? 'query' : 'queries'} run
                      </summary>
                      <div className="mt-1 space-y-1">
                        {m.sql_runs.map((r, j) => (
                          <div key={j} className="font-mono break-all bg-gray-50 rounded p-1.5 border border-gray-100">
                            <div className="text-gray-700">{r.query}</div>
                            <div className="text-gray-400 mt-0.5">
                              {r.error ? `error: ${r.error}` : `${r.row_count} row${r.row_count === 1 ? '' : 's'}`}
                            </div>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              </div>
            ))}

            {busy && (
              <div className="flex justify-start">
                <div className="bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-500">
                  <span className="inline-flex gap-1">
                    <span className="animate-pulse">•</span>
                    <span className="animate-pulse" style={{ animationDelay: '0.2s' }}>•</span>
                    <span className="animate-pulse" style={{ animationDelay: '0.4s' }}>•</span>
                  </span>
                </div>
              </div>
            )}
          </div>

          <div className="border-t border-gray-200 p-2 bg-white">
            <div className="flex gap-2 items-end">
              <textarea
                ref={inputRef}
                rows={1}
                className="input flex-1 text-sm resize-none"
                placeholder="Ask anything about your ERP data…"
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                disabled={busy}
              />
              <button
                onClick={send}
                disabled={busy || !input.trim()}
                className="btn btn-primary px-3 py-2 flex-shrink-0 disabled:opacity-40"
              >
                <FiSend size={14} />
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
