import { FiX } from 'react-icons/fi';

export default function Modal({ isOpen, onClose, title, children, wide, xwide, className = '' }) {
  if (!isOpen) return null;
  return (
    <div className="!m-0 fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-black/40 backdrop-blur-xs" onClick={onClose}>
      <div
        className={`bg-white rounded-xl shadow-xl w-full max-w-[96vw] ${xwide ? 'sm:max-w-[720px] md:max-w-[960px] lg:max-w-[1040px]' : wide ? 'sm:max-w-[640px] md:max-w-[800px]' : 'sm:max-w-[500px]'} max-h-[92vh] flex flex-col overflow-hidden ${className}`}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-3 sm:p-5 border-b bg-white z-10 flex-shrink-0">
          <h3 className="text-base sm:text-lg font-semibold truncate pr-2">{title}</h3>
          <button onClick={onClose} aria-label="Close dialog" className="p-1.5 hover:bg-gray-100 rounded-lg flex-shrink-0 text-gray-500 hover:text-gray-700"><FiX size={20} /></button>
        </div>
        <div className="p-3 sm:p-5 overflow-y-auto flex-1">{children}</div>
      </div>
    </div>
  );
}
