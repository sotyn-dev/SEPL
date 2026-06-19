// Right-anchored, full-height side drawer. Roughly half the viewport on desktop,
// full width on mobile. Sticky header slot + scrollable body. Click the backdrop
// or the X to close. Used by FunnelLeadDrawer instead of the centered Modal so the
// lead workspace gets more vertical real estate.

import { FiX } from 'react-icons/fi';

export default function Drawer({ isOpen, onClose, header, children }) {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <style>{'@keyframes l2dSlideIn{from{transform:translateX(100%)}to{transform:translateX(0)}}'}</style>
      <div
        className="bg-white h-full w-full sm:max-w-[680px] lg:w-[52vw] lg:max-w-[820px] shadow-2xl flex flex-col"
        style={{ animation: 'l2dSlideIn 0.2s ease-out' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b sticky top-0 bg-white z-10">
          <div className="flex-1 min-w-0 pr-2">{header}</div>
          <button onClick={onClose} aria-label="Close" className="p-1 hover:bg-gray-100 rounded-lg flex-shrink-0">
            <FiX size={20} />
          </button>
        </div>
        <div className="p-4 overflow-y-auto flex-1">{children}</div>
      </div>
    </div>
  );
}
