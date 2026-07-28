import { useState, useRef, useCallback, Children } from 'react';
import { FiChevronLeft, FiChevronRight } from 'react-icons/fi';

// Slider — a reusable, presentational slide shell. It does ONE thing: slide
// between its children (each direct child = one slide). Content-agnostic — slides
// bring their own layout — so it drops into any "step through cards" spot.
//
// Navigation: prev/next arrows, clickable dots, ←/→ keys (when focused), and
// touch / pointer swipe. Uncontrolled by default; pass `index` + `onIndexChange`
// to drive it from outside. Slides stretch to the tallest so there's no height
// jump between them.
export default function Slider({
  children,
  index: controlledIndex,
  onIndexChange,
  loop = false,
  showDots = true,
  showArrows = true,
  showCount = false,
  stickyFooter = false,
  className = '',
  ariaLabel = 'Slides',
}) {
  const slides = Children.toArray(children).filter(Boolean);
  const count = slides.length;
  const [internal, setInternal] = useState(0);
  const isControlled = controlledIndex != null;
  const idx = Math.min(isControlled ? controlledIndex : internal, Math.max(count - 1, 0));

  const go = useCallback((to) => {
    let n = to;
    if (loop && count) n = ((n % count) + count) % count;
    else n = Math.max(0, Math.min(count - 1, n));
    if (!isControlled) setInternal(n);
    onIndexChange?.(n);
  }, [count, loop, isControlled, onIndexChange]);

  const onKeyDown = (e) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); go(idx - 1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); go(idx + 1); }
  };

  // Pointer swipe (works for touch + mouse drag); a small threshold avoids
  // hijacking taps/clicks on controls inside a slide.
  const startX = useRef(null);
  const onPointerDown = (e) => { startX.current = e.clientX; };
  const onPointerUp = (e) => {
    if (startX.current == null) return;
    const dx = e.clientX - startX.current;
    startX.current = null;
    if (Math.abs(dx) > 45) go(idx + (dx < 0 ? 1 : -1));
  };

  if (!count) return null;
  const atStart = !loop && idx === 0;
  const atEnd = !loop && idx === count - 1;

  return (
    <div className={`flex flex-col ${className}`} tabIndex={0} onKeyDown={onKeyDown}
      role="group" aria-roledescription="carousel" aria-label={ariaLabel}>
      <div className="overflow-hidden" onPointerDown={onPointerDown} onPointerUp={onPointerUp}>
        <div className="flex transition-transform duration-300 ease-out motion-reduce:transition-none"
          style={{ transform: `translateX(-${idx * 100}%)` }}>
          {slides.map((slide, i) => (
            <div key={i} className="basis-full shrink-0 grow-0 min-w-0"
              role="group" aria-roledescription="slide" aria-label={`${i + 1} of ${count}`}
              aria-hidden={i !== idx} inert={i !== idx ? true : undefined}>
              {slide}
            </div>
          ))}
        </div>
      </div>

      {(showArrows || showDots || showCount) && count > 1 && (
        <div className={`flex items-center justify-between gap-3 ${stickyFooter ? 'sticky bottom-0 bg-white border-t border-gray-100 pt-3 pb-1 mt-3' : 'pt-4'}`}>
          {showArrows
            ? <button type="button" className="btn btn-secondary !px-3" onClick={() => go(idx - 1)} disabled={atStart} aria-label="Previous"><FiChevronLeft /></button>
            : <span />}

          <div className="flex items-center gap-2">
            {showDots && slides.map((_, i) => (
              <button key={i} type="button" onClick={() => go(i)} aria-label={`Go to slide ${i + 1}`} aria-current={i === idx}
                className={`h-2 rounded-full transition-all ${i === idx ? 'w-5 bg-red-600' : 'w-2 bg-gray-300 hover:bg-gray-400'}`} />
            ))}
            {showCount && <span className="text-xs text-gray-400 tabular-nums ml-1">{idx + 1} / {count}</span>}
          </div>

          {showArrows
            ? <button type="button" className="btn btn-secondary !px-3" onClick={() => go(idx + 1)} disabled={atEnd} aria-label="Next"><FiChevronRight /></button>
            : <span />}
        </div>
      )}
    </div>
  );
}
