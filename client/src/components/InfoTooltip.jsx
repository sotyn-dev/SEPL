import { useState } from 'react';
import { FiInfo } from 'react-icons/fi';

// InfoTooltip — small (i) icon that reveals a longer text on hover/focus.
//
// Used when a field label needs more explanation than fits inline (e.g.
// dropdowns where the OPTIONS contain long descriptive labels that get
// truncated in the select box).  Pass the long text as `text`; mam can
// also pass JSX via `children` for richer popovers.
//
// Usage:
//   <label className="label flex items-center gap-1">
//     Site
//     <InfoTooltip text="Picks the destination site for this indent. Long names will be truncated in the dropdown — hover here to see the full list." />
//   </label>
export default function InfoTooltip({ text, children, side = 'top', className = '' }) {
  const [open, setOpen] = useState(false);
  const sideClass = {
    top:    'bottom-full left-1/2 -translate-x-1/2 mb-2',
    bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
    left:   'right-full top-1/2 -translate-y-1/2 mr-2',
    right:  'left-full top-1/2 -translate-y-1/2 ml-2',
  }[side] || 'bottom-full left-1/2 -translate-x-1/2 mb-2';
  return (
    <span
      className={`relative inline-flex items-center ${className}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      tabIndex={0}
    >
      <FiInfo size={12} className="text-gray-400 hover:text-blue-600 cursor-help" />
      {open && (
        <span
          role="tooltip"
          className={`absolute z-50 ${sideClass} px-3 py-2 rounded-md bg-gray-900 text-white text-[11px] leading-snug font-normal shadow-lg w-64 max-w-[280px] whitespace-pre-wrap break-words`}>
          {children || text}
        </span>
      )}
    </span>
  );
}
