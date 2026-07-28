import { FiX } from 'react-icons/fi';

export default function Modal({ isOpen, onClose, title, subtitle, children, wide, xwide }) {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className={`bg-white rounded-xl shadow-xl w-[95vw] ${xwide ? 'sm:max-w-[720px] md:max-w-[960px] lg:max-w-[1040px]' : wide ? 'sm:max-w-[640px] md:max-w-[800px]' : 'sm:max-w-[500px]'} max-h-[90vh] overflow-y-auto mx-2`}
        onClick={e => e.stopPropagation()}
      >
        {/* Header wraps to 2 lines instead of hard-truncating (long titles like
            "Add sub-department under <Long Company Name>" were ellipsis-clipped).
            Optional `subtitle` gives a clean 2-line split: bold title + muted context. */}
        <div className="flex items-start justify-between gap-2 p-3 sm:p-5 border-b sticky top-0 bg-white z-10">
          <div className="min-w-0 pr-1">
            <h3 className="text-base sm:text-lg font-semibold leading-tight line-clamp-2">{title}</h3>
            {subtitle && <p className="text-xs text-gray-400 mt-0.5 line-clamp-2">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded-lg flex-shrink-0 -mt-0.5"><FiX size={20} /></button>
        </div>
        <div className="p-3 sm:p-5">{children}</div>
      </div>
    </div>
  );
}
