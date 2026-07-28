import { FiX } from 'react-icons/fi';

export default function Modal({ isOpen, onClose, title, subtitle, children, wide, xwide, scrollOutside }) {
  if (!isOpen) return null;

  const widthCls = xwide
    ? 'sm:max-w-[720px] md:max-w-[960px] lg:max-w-[1040px]'
    : wide ? 'sm:max-w-[640px] md:max-w-[800px]' : 'sm:max-w-[500px]';

  // ONE structure, a few classes swapped by `scrollOutside`:
  //  • default       → card clips + scrolls internally (max-h/overflow), sticky header.
  //  • scrollOutside → the OVERLAY scrolls, the card never clips — so a popover/
  //    dropdown inside (e.g. PeoplePicker) can't be cut off. Opt-in per modal.
  // The min-h-full centering wrapper is shared: short modals centre, tall ones
  // scroll from the top with no cut-off.
  return (
    <div
      className={`fixed inset-0 z-50 bg-black/40 !m-0 ${scrollOutside ? 'overflow-y-auto' : 'overflow-hidden'}`}
      onClick={onClose}
    >
      <div className={`flex min-h-full items-center justify-center px-4 ${scrollOutside ? 'py-12' : 'py-4'}`}>
        <div
          className={`bg-white rounded-xl shadow-xl w-full ${widthCls} ${scrollOutside ? '' : 'max-h-[90vh] overflow-y-auto'}`}
          onClick={e => e.stopPropagation()}
        >
          <div className={`flex items-start justify-between gap-2 p-3 sm:p-5 border-b ${scrollOutside ? '' : 'sticky top-0 bg-white z-10'}`}>
            {/* Header wraps to 2 lines instead of hard-truncating; optional
                `subtitle` gives a bold-title + muted-context split. */}
            <div className="min-w-0 pr-1">
              <h3 className="text-base sm:text-lg font-semibold leading-tight line-clamp-2">{title}</h3>
              {subtitle && <p className="text-xs text-gray-400 mt-0.5 line-clamp-2">{subtitle}</p>}
            </div>
            <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded-lg flex-shrink-0 -mt-0.5"><FiX size={20} /></button>
          </div>
          <div className="p-3 sm:p-5">{children}</div>
        </div>
      </div>
    </div>
  );
}
