import { useState, useMemo, useEffect } from 'react';
import { FiX, FiSmile } from 'react-icons/fi';
import Modal from './Modal';
import { fmtDateTime } from '../utils/datetime';

const QUICK_EMOJIS = ['👍', '❤️', '🔥', '😂', '👏', '🎉', '🙏', '💯', '😮', '😢'];

export default function ChatReactionsModal({ isOpen, onClose, message, reactions = [], onReact, currentUserId, initialEmoji }) {
  const [activeTab, setActiveTab] = useState('ALL');

  useEffect(() => {
    if (isOpen) {
      setActiveTab(initialEmoji || 'ALL');
    }
  }, [isOpen, initialEmoji]);

  // Group reactions by emoji (ALWAYS called at top level before any return)
  const countsByEmoji = useMemo(() => {
    const list = Array.isArray(reactions) ? reactions : [];
    const map = {};
    for (const r of list) {
      if (r && r.emoji) {
        map[r.emoji] = (map[r.emoji] || 0) + 1;
      }
    }
    return map;
  }, [reactions]);

  const emojiList = Object.keys(countsByEmoji);

  const filteredReactions = useMemo(() => {
    const list = Array.isArray(reactions) ? reactions : [];
    if (activeTab === 'ALL') return list;
    return list.filter(r => r && r.emoji === activeTab);
  }, [reactions, activeTab]);

  // Conditional early return AFTER all hooks
  if (!isOpen || !message) return null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Message Reactions"
    >
      <div className="space-y-4">
        {/* Message snippet preview */}
        {message.body && (
          <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-700 italic max-h-16 overflow-hidden text-ellipsis line-clamp-2">
            "{message.body}"
          </div>
        )}

        {/* Emoji Tabs */}
        <div className="flex gap-1.5 overflow-x-auto pb-1 border-b border-slate-200 text-xs scrollbar-none">
          <button
            type="button"
            onClick={() => setActiveTab('ALL')}
            className={`px-3 py-1.5 rounded-full font-semibold transition whitespace-nowrap flex items-center gap-1 ${
              activeTab === 'ALL'
                ? 'bg-blue-600 text-white shadow-xs'
                : 'bg-slate-100 hover:bg-slate-200 text-slate-700'
            }`}
          >
            All <span className="text-[11px] opacity-80">({reactions.length})</span>
          </button>
          {emojiList.map(em => (
            <button
              key={em}
              type="button"
              onClick={() => setActiveTab(em)}
              className={`px-3 py-1.5 rounded-full font-semibold transition whitespace-nowrap flex items-center gap-1 ${
                activeTab === em
                  ? 'bg-blue-600 text-white shadow-xs'
                  : 'bg-slate-100 hover:bg-slate-200 text-slate-700'
              }`}
            >
              <span>{em}</span>
              <span className="text-[11px] opacity-80 font-bold">{countsByEmoji[em]}</span>
            </button>
          ))}
        </div>

        {/* Reactor Users List */}
        <div className="max-h-72 overflow-y-auto divide-y divide-slate-100 pr-1">
          {filteredReactions.length === 0 ? (
            <div className="py-8 text-center text-xs text-slate-400">
              No reactions in this category
            </div>
          ) : (
            filteredReactions.map(r => {
              const isMine = r.user_id === currentUserId || r.is_me;
              return (
                <div key={r.id || `${r.user_id}-${r.emoji}`} className="py-2.5 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="relative shrink-0">
                      {r.avatar_url ? (
                        <img
                          src={r.avatar_url}
                          alt={r.user_name}
                          className="w-9 h-9 rounded-full object-cover border border-slate-200"
                        />
                      ) : (
                        <div className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 text-white font-bold text-xs flex items-center justify-center uppercase shadow-xs">
                          {(r.user_name || 'U').slice(0, 2)}
                        </div>
                      )}
                      <span className="absolute -bottom-1 -right-1 text-sm bg-white rounded-full shadow-xs px-0.5 leading-none">
                        {r.emoji}
                      </span>
                    </div>
                    <div className="min-w-0">
                      <div className="font-semibold text-xs text-slate-900 truncate flex items-center gap-1.5">
                        <span>{r.user_name || 'Team member'}</span>
                        {isMine && (
                          <span className="text-[10px] font-bold text-blue-700 bg-blue-50 px-1.5 py-0.2 rounded">
                            You
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-slate-400 truncate">
                        {r.department ? `${r.department} · ` : ''}{r.created_at ? fmtDateTime(r.created_at) : 'recently'}
                      </div>
                    </div>
                  </div>

                  {isMine && onReact && (
                    <button
                      type="button"
                      onClick={() => {
                        onReact(message.id, r.emoji);
                        onClose();
                      }}
                      className="text-[11px] text-red-600 hover:text-red-700 font-medium px-2 py-1 rounded hover:bg-red-50 transition"
                      title="Click to remove your reaction"
                    >
                      Remove
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Quick React Bar at bottom */}
        {onReact && (
          <div className="pt-2 border-t border-slate-200">
            <div className="text-[11px] font-medium text-slate-500 mb-1.5 flex items-center gap-1">
              <FiSmile size={13} /> Tap to react:
            </div>
            <div className="flex flex-wrap gap-1.5">
              {QUICK_EMOJIS.map(em => {
                const hasReacted = reactions.some(r => (r.user_id === currentUserId || r.is_me) && r.emoji === em);
                return (
                  <button
                    key={em}
                    type="button"
                    onClick={() => {
                      onReact(message.id, em);
                      onClose();
                    }}
                    className={`text-lg p-1.5 rounded-lg transition hover:scale-110 active:scale-95 ${
                      hasReacted
                        ? 'bg-blue-100 ring-2 ring-blue-400'
                        : 'bg-slate-100 hover:bg-slate-200'
                    }`}
                    title={hasReacted ? `Remove ${em}` : `React with ${em}`}
                  >
                    {em}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="flex justify-end pt-2 border-t border-slate-100">
          <button
            type="button"
            onClick={onClose}
            className="btn btn-secondary text-xs px-4"
          >
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}
