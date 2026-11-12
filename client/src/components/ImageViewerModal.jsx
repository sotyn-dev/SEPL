import { useState, useRef, useEffect, useCallback } from 'react';
import {
  FiArrowLeft,
  FiX,
  FiDownload,
  FiZoomIn,
  FiZoomOut,
  FiRotateCcw,
  FiMaximize2
} from 'react-icons/fi';

export default function ImageViewerModal({ src, name, downloadUrl, onClose }) {
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const posStartRef = useRef({ x: 0, y: 0 });
  const containerRef = useRef(null);
  const lastTapRef = useRef(0);
  const initialPinchDistRef = useRef(null);
  const initialScaleRef = useRef(1);

  // Reset zoom & pan when image changes or on mount
  useEffect(() => {
    setScale(1);
    setPosition({ x: 0, y: 0 });
  }, [src]);

  // Lock body scroll while modal is open
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  // Keyboard navigation (+, -, 0, Escape)
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        onClose?.();
      } else if (e.key === '+' || e.key === '=') {
        handleZoomIn();
      } else if (e.key === '-' || e.key === '_') {
        handleZoomOut();
      } else if (e.key === '0') {
        handleReset();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handleZoomIn = useCallback(() => {
    setScale((prev) => Math.min(5, Math.round((prev + 0.35) * 100) / 100));
  }, []);

  const handleZoomOut = useCallback(() => {
    setScale((prev) => {
      const next = Math.max(0.5, Math.round((prev - 0.35) * 100) / 100);
      if (next <= 1) setPosition({ x: 0, y: 0 });
      return next;
    });
  }, []);

  const handleReset = useCallback(() => {
    setScale(1);
    setPosition({ x: 0, y: 0 });
  }, []);

  // Mouse Wheel Zoom
  const handleWheel = (e) => {
    e.preventDefault();
    if (e.deltaY < 0) {
      // Zoom in
      setScale((prev) => Math.min(5, Math.round((prev + 0.2) * 100) / 100));
    } else {
      // Zoom out
      setScale((prev) => {
        const next = Math.max(0.5, Math.round((prev - 0.2) * 100) / 100);
        if (next <= 1) setPosition({ x: 0, y: 0 });
        return next;
      });
    }
  };

  // Double click / Double tap to toggle zoom (1x <-> 2.5x)
  const handleDoubleTap = (e) => {
    e.stopPropagation();
    if (scale > 1) {
      handleReset();
    } else {
      setScale(2.5);
    }
  };

  // Mouse Drag / Pan
  const handleMouseDown = (e) => {
    if (e.button !== 0) return; // Left click only
    setIsDragging(true);
    dragStartRef.current = { x: e.clientX, y: e.clientY };
    posStartRef.current = { ...position };
  };

  const handleMouseMove = (e) => {
    if (!isDragging) return;
    const dx = e.clientX - dragStartRef.current.x;
    const dy = e.clientY - dragStartRef.current.y;
    setPosition({
      x: posStartRef.current.x + dx,
      y: posStartRef.current.y + dy
    });
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  // Mobile Touch Handlers: Drag & Pinch-to-Zoom
  const getDistance = (t1, t2) => {
    const dx = t1.clientX - t2.clientX;
    const dy = t1.clientY - t2.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  };

  const handleTouchStart = (e) => {
    if (e.touches.length === 1) {
      // Single touch -> check double tap or pan
      const now = Date.now();
      if (now - lastTapRef.current < 300) {
        handleDoubleTap(e);
        lastTapRef.current = 0;
        return;
      }
      lastTapRef.current = now;

      setIsDragging(true);
      dragStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      posStartRef.current = { ...position };
    } else if (e.touches.length === 2) {
      // Pinch to zoom
      setIsDragging(false);
      initialPinchDistRef.current = getDistance(e.touches[0], e.touches[1]);
      initialScaleRef.current = scale;
    }
  };

  const handleTouchMove = (e) => {
    if (e.touches.length === 1 && isDragging && scale > 1) {
      const dx = e.touches[0].clientX - dragStartRef.current.x;
      const dy = e.touches[0].clientY - dragStartRef.current.y;
      setPosition({
        x: posStartRef.current.x + dx,
        y: posStartRef.current.y + dy
      });
    } else if (e.touches.length === 2 && initialPinchDistRef.current) {
      const currentDist = getDistance(e.touches[0], e.touches[1]);
      const factor = currentDist / initialPinchDistRef.current;
      const newScale = Math.min(5, Math.max(0.5, Math.round(initialScaleRef.current * factor * 100) / 100));
      setScale(newScale);
      if (newScale <= 1) setPosition({ x: 0, y: 0 });
    }
  };

  const handleTouchEnd = (e) => {
    if (e.touches.length === 0) {
      setIsDragging(false);
      initialPinchDistRef.current = null;
    } else if (e.touches.length === 1) {
      initialPinchDistRef.current = null;
      dragStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      posStartRef.current = { ...position };
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col justify-between select-none overflow-hidden"
      style={{ backgroundColor: 'rgba(5, 8, 16, 0.98)', backdropFilter: 'blur(10px)' }}
      onMouseUp={handleMouseUp}
      onTouchEnd={handleTouchEnd}
    >
      {/* Top Header Bar */}
      <div
        className="flex items-center justify-between px-3 sm:px-6 py-2.5 z-20 shrink-0 shadow-xl gap-2 flex-wrap"
        style={{ backgroundColor: '#0f172a', borderBottom: '1px solid rgba(255, 255, 255, 0.12)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Left: Back / Close Button + File Title */}
        <div className="flex items-center gap-2.5 min-w-0 max-w-[40%] sm:max-w-xs">
          <button
            type="button"
            onClick={onClose}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 active:bg-gray-600 text-white font-semibold text-xs sm:text-sm border border-gray-600 shadow-md transition touch-manipulation cursor-pointer shrink-0"
            title="Close image (or press phone Back)"
            aria-label="Close image"
          >
            <FiArrowLeft size={17} className="text-white shrink-0" />
            <span className="hidden sm:inline">Close</span>
          </button>
          <span className="text-white text-xs sm:text-sm font-semibold truncate" title={name || 'Photo preview'}>
            {name || 'Photo preview'}
          </span>
        </div>

        {/* Center: Interactive Zoom Toolbar */}
        <div className="flex items-center gap-1 sm:gap-2 bg-slate-800/90 border border-slate-700/80 rounded-xl px-2 py-1 shadow-inner">
          <button
            type="button"
            onClick={handleZoomOut}
            disabled={scale <= 0.5}
            className="p-1.5 rounded-lg text-gray-200 hover:text-white hover:bg-slate-700 active:bg-slate-600 transition disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            title="Zoom out (−)"
            aria-label="Zoom out"
          >
            <FiZoomOut size={16} />
          </button>

          <button
            type="button"
            onClick={handleReset}
            className="px-2 py-0.5 rounded text-xs font-mono font-bold text-blue-400 hover:text-white hover:bg-slate-700 transition cursor-pointer"
            title="Click to reset zoom to 100%"
          >
            {Math.round(scale * 100)}%
          </button>

          <button
            type="button"
            onClick={handleZoomIn}
            disabled={scale >= 5}
            className="p-1.5 rounded-lg text-gray-200 hover:text-white hover:bg-slate-700 active:bg-slate-600 transition disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            title="Zoom in (+)"
            aria-label="Zoom in"
          >
            <FiZoomIn size={16} />
          </button>

          <div className="h-4 w-px bg-slate-700 mx-0.5" />

          <button
            type="button"
            onClick={handleReset}
            className="p-1.5 rounded-lg text-gray-300 hover:text-white hover:bg-slate-700 active:bg-slate-600 transition cursor-pointer"
            title="Fit to Screen / Reset (0)"
            aria-label="Fit to screen"
          >
            <FiRotateCcw size={14} />
          </button>
        </div>

        {/* Right: Download Button + Big Red Close Button */}
        <div className="flex items-center gap-2 shrink-0">
          <a
            href={downloadUrl || src}
            download={name || 'image'}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white font-semibold text-xs sm:text-sm shadow-md transition touch-manipulation cursor-pointer"
            title="Download image"
            onClick={(e) => e.stopPropagation()}
          >
            <FiDownload size={15} className="shrink-0" />
            <span className="hidden sm:inline">Download</span>
          </a>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 sm:px-2.5 sm:py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 active:bg-rose-700 text-white shadow-md transition touch-manipulation cursor-pointer flex items-center justify-center gap-1 text-xs sm:text-sm font-bold"
            title="Close (✕ or Esc)"
            aria-label="Close"
          >
            <FiX size={18} />
          </button>
        </div>
      </div>

      {/* Center Zoomable & Draggable Canvas */}
      <div
        ref={containerRef}
        className={`flex-1 flex items-center justify-center p-2 sm:p-4 min-h-0 overflow-hidden relative ${
          scale > 1 ? (isDragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-default'
        }`}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onClick={(e) => {
          // If clicked directly on the dark canvas backdrop, close
          if (e.target === containerRef.current) {
            onClose?.();
          }
        }}
      >
        <img
          src={src}
          alt={name || 'Preview'}
          draggable={false}
          onDoubleClick={handleDoubleTap}
          style={{
            transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`,
            transformOrigin: 'center center',
            transition: isDragging ? 'none' : 'transform 0.15s ease-out',
            touchAction: 'none'
          }}
          className="max-h-[82vh] max-w-[96vw] object-contain rounded-lg shadow-2xl pointer-events-auto"
        />
      </div>

      {/* Bottom Guidance Footer Bar */}
      <div
        className="px-4 py-2 text-center shrink-0 z-20 flex items-center justify-between sm:justify-center gap-4 text-xs text-gray-300 font-medium"
        style={{ backgroundColor: '#0f172a', borderTop: '1px solid rgba(255, 255, 255, 0.12)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="hidden sm:block text-gray-400">
          💡 <strong>Tip:</strong> Mouse wheel or <span className="font-mono text-blue-400 font-bold">+ / −</span> to zoom · Drag to pan · Double-click to toggle 2.5x · <span className="font-mono text-blue-400 font-bold">0</span> to reset
        </div>
        <div className="sm:hidden text-gray-400 text-[11px]">
          💡 <strong>Pinch</strong> to zoom · <strong>Drag</strong> to pan · <strong>Double-tap</strong> to zoom
        </div>
        <div>
          Tap <span className="font-bold text-white bg-rose-600/80 px-1.5 py-0.5 rounded text-[11px]">✕ Close</span> or press <span className="font-bold text-white underline">Back</span>
        </div>
      </div>
    </div>
  );
}

