import { useState } from 'react';
import { FiChevronLeft, FiChevronRight, FiX, FiCornerDownRight } from 'react-icons/fi';
import { BsPinAngleFill } from 'react-icons/bs';

export default function ChatPinnedBanner({ pins = [], onJump, onUnpin, canManage = true }) {
  const [currentIndex, setCurrentIndex] = useState(0);

  if (!pins || !pins.length) return null;

  // Ensure current index is within bounds
  const safeIndex = Math.min(currentIndex, pins.length - 1);
  const currentPin = pins[safeIndex];
  if (!currentPin) return null;

  const handlePrev = (e) => {
    e.stopPropagation();
    setCurrentIndex(prev => (prev - 1 + pins.length) % pins.length);
  };

  const handleNext = (e) => {
    e.stopPropagation();
    setCurrentIndex(prev => (prev + 1) % pins.length);
  };

  const snippet = currentPin.body
    ? currentPin.body.replace(/\n+/g, ' ').trim()
    : currentPin.attachment_name
    ? `📎 ${currentPin.attachment_name}`
    : 'Attachment';

  return (
    <div
      onClick={() => onJump && onJump(currentPin.message_id)}
      className="bg-white/95 backdrop-blur-md border-b border-amber-200/80 shadow-xs px-3 py-2 flex items-center justify-between gap-3 cursor-pointer hover:bg-amber-50/60 transition-all select-none sticky top-0 z-20 group"
      title="Click to jump to this pinned message"
    >
      <div className="flex items-center gap-2.5 min-w-0 flex-1">
        <div className="w-7 h-7 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center shrink-0 shadow-2xs group-hover:bg-amber-200 transition-colors">
          <BsPinAngleFill size={13} className="rotate-45" />
        </div>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="flex items-center gap-1.5 text-[11px] font-bold text-amber-900">
            <span>Pinned Message</span>
            {currentPin.sender_name && (
              <span className="font-normal text-slate-500 truncate">
                · {currentPin.sender_name}
              </span>
            )}
            {pins.length > 1 && (
              <span className="text-[10px] bg-amber-100 text-amber-800 px-1.5 py-0.2 rounded-full font-semibold">
                {safeIndex + 1}/{pins.length}
              </span>
            )}
          </div>
          <div className="text-xs text-slate-700 truncate mt-0.5 font-medium">
            {snippet}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1 shrink-0" onClick={e => e.stopPropagation()}>
        {pins.length > 1 && (
          <div className="flex items-center bg-slate-100 rounded-lg p-0.5">
            <button
              type="button"
              onClick={handlePrev}
              className="p-1 text-slate-600 hover:text-slate-900 rounded hover:bg-slate-200 transition"
              title="Previous pinned message"
            >
              <FiChevronLeft size={14} />
            </button>
            <button
              type="button"
              onClick={handleNext}
              className="p-1 text-slate-600 hover:text-slate-900 rounded hover:bg-slate-200 transition"
              title="Next pinned message"
            >
              <FiChevronRight size={14} />
            </button>
          </div>
        )}

        <button
          type="button"
          onClick={() => onJump && onJump(currentPin.message_id)}
          className="p-1.5 text-blue-600 hover:text-blue-800 rounded-lg hover:bg-blue-50 transition hidden sm:inline-flex items-center gap-1 text-[11px] font-medium"
          title="Jump to message"
        >
          <FiCornerDownRight size={13} />
          <span>Jump</span>
        </button>

        {canManage && onUnpin && (
          <button
            type="button"
            onClick={() => onUnpin(currentPin.message_id)}
            className="p-1.5 text-slate-400 hover:text-red-600 rounded-lg hover:bg-red-50 transition"
            title="Unpin message"
          >
            <FiX size={15} />
          </button>
        )}
      </div>
    </div>
  );
}
