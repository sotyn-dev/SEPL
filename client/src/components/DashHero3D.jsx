// 3D dashboard hero (mam 2026-08-12: "dashboard look like 3d type").
// Pattern follows the architect fork's BlueprintHero: one self-contained
// component, all CSS in the inline <style> block (s3d- prefix), zero new
// dependencies, every looping animation compositor-friendly (transform /
// opacity only) and fully disabled under prefers-reduced-motion.
//
// It also carries the page-wide `.dash3d` depth styles: Dashboard.jsx puts
// `dash3d` on its root, and every `.card` / `.d3-card` inside gets a real
// 3D hover lift (perspective on the root → rotateX tilts foreshorten).

const CSS = `
@keyframes s3dFloat { 0%,100% { transform: translateY(0) rotateY(-6deg) rotateX(2deg); } 50% { transform: translateY(-9px) rotateY(6deg) rotateX(4deg); } }
.s3d-float { animation: s3dFloat 7s ease-in-out infinite; }
@keyframes s3dLamp { 0%,100% { opacity: .75; } 50% { opacity: 1; } }
.s3d-lamp { animation: s3dLamp 5s ease-in-out infinite; }
@keyframes s3dScan { 0% { left: -2%; } 100% { left: 102%; } }
.s3d-scan { animation: s3dScan 9s linear infinite; }
@keyframes s3dWin { 0%,100% { opacity: .9; } 50% { opacity: .45; } }
.s3d-win { animation: s3dWin 4s ease-in-out infinite; }
@keyframes s3dBeacon { 0%,100% { opacity: 1; } 50% { opacity: .2; } }
.s3d-beacon { animation: s3dBeacon 1.6s ease-in-out infinite; }
@keyframes s3dRise { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }
.s3d-rise { animation: s3dRise .6s ease both; }

/* ---- page-wide 3D depth (root of Dashboard.jsx carries .dash3d) ---- */
.dash3d { perspective: 1600px; }
.dash3d .card, .dash3d .d3-card {
  transition: transform .3s ease, box-shadow .3s ease;
}
.dash3d .card:hover, .dash3d .d3-card:hover {
  transform: translateY(-5px) rotateX(1.2deg);
  box-shadow: 0 24px 44px -18px rgba(23,37,84,.35), 0 2px 8px rgba(23,37,84,.08);
}
/* staggered entrance for the top-level sections */
.dash3d > * { animation: s3dRise .5s ease both; }
.dash3d > *:nth-child(3) { animation-delay: 90ms; }
.dash3d > *:nth-child(4) { animation-delay: 180ms; }
.dash3d > *:nth-child(5) { animation-delay: 270ms; }
.dash3d > *:nth-child(6) { animation-delay: 360ms; }
.dash3d > *:nth-child(7) { animation-delay: 450ms; }

@media (prefers-reduced-motion: reduce) {
  .s3d-float, .s3d-lamp, .s3d-scan, .s3d-win, .s3d-beacon, .s3d-rise, .dash3d > * { animation: none; }
  .dash3d .card:hover, .dash3d .d3-card:hover { transform: none; }
}
`;

// Axonometric SEPL "site tower" — two iso boxes with classic 3-face shading
// (light top / dark left / mid right), twinkling windows, a pulsing red
// beacon (fire-safety brand nod) and a ground contact shadow.
function IsoTower() {
  return (
    <svg viewBox="0 0 320 260" className="w-full h-full" aria-hidden="true">
      <defs>
        <linearGradient id="s3dTop" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#93c5fd" /><stop offset="100%" stopColor="#60a5fa" />
        </linearGradient>
        <linearGradient id="s3dLeft" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#1e3a8a" /><stop offset="100%" stopColor="#172554" />
        </linearGradient>
        <linearGradient id="s3dRight" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#3b82f6" /><stop offset="100%" stopColor="#1e40af" />
        </linearGradient>
        <filter id="s3dGlow"><feDropShadow dx="0" dy="14" stdDeviation="12" floodColor="#000" floodOpacity="0.45" /></filter>
      </defs>

      {/* ground contact shadow */}
      <ellipse cx="170" cy="245" rx="130" ry="14" fill="#000" opacity="0.28" />

      <g filter="url(#s3dGlow)">
        {/* back tower (taller) */}
        <polygon points="70,80 130,50 190,80 130,110" fill="url(#s3dTop)" />
        <polygon points="70,80 70,180 130,210 130,110" fill="url(#s3dLeft)" />
        <polygon points="190,80 190,180 130,210 130,110" fill="url(#s3dRight)" />
        {/* windows — warm on the lit (right) face, cool/dim on the shadow (left) face */}
        <g className="s3d-win">
          <rect x="143" y="112" width="9" height="11" fill="#fde68a" transform="skewY(24)" transformOrigin="143 112" />
          <rect x="160" y="112" width="9" height="11" fill="#fde68a" transform="skewY(24)" transformOrigin="160 112" />
          <rect x="143" y="136" width="9" height="11" fill="#fde68a" opacity="0.8" transform="skewY(24)" transformOrigin="143 136" />
          <rect x="160" y="136" width="9" height="11" fill="#fde68a" opacity="0.65" transform="skewY(24)" transformOrigin="160 136" />
        </g>
        <g opacity="0.5">
          <rect x="86" y="112" width="9" height="11" fill="#bfdbfe" transform="skewY(-24)" transformOrigin="86 112" />
          <rect x="103" y="112" width="9" height="11" fill="#bfdbfe" transform="skewY(-24)" transformOrigin="103 112" />
          <rect x="86" y="136" width="9" height="11" fill="#bfdbfe" transform="skewY(-24)" transformOrigin="86 136" />
        </g>
        {/* beacon mast + pulsing red lamp */}
        <line x1="130" y1="50" x2="130" y2="34" stroke="#cbd5e1" strokeWidth="2" />
        <circle cx="130" cy="30" r="9" fill="#ef4444" opacity="0.3" className="s3d-beacon" />
        <circle cx="130" cy="30" r="4" fill="#ef4444" className="s3d-beacon" />

        {/* front tower (shorter, offset right) */}
        <polygon points="150,140 210,110 270,140 210,170" fill="url(#s3dTop)" />
        <polygon points="150,140 150,210 210,240 210,170" fill="url(#s3dLeft)" />
        <polygon points="270,140 270,210 210,240 210,170" fill="url(#s3dRight)" />
        <g className="s3d-win">
          <rect x="223" y="172" width="9" height="11" fill="#fde68a" transform="skewY(24)" transformOrigin="223 172" />
          <rect x="240" y="172" width="9" height="11" fill="#fde68a" opacity="0.75" transform="skewY(24)" transformOrigin="240 172" />
        </g>
        <g opacity="0.5">
          <rect x="166" y="172" width="9" height="11" fill="#bfdbfe" transform="skewY(-24)" transformOrigin="166 172" />
        </g>
      </g>
    </svg>
  );
}

export default function DashHero3D({ greeting, name }) {
  const dateLabel = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return (
    <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-blue-950 via-blue-900 to-blue-800 shadow-2xl shadow-blue-950/40">
      <style>{CSS}</style>

      {/* drafting grid — 4 stacked linear-gradients, zero extra DOM per line */}
      <div
        className="absolute inset-0 opacity-[0.08] pointer-events-none"
        style={{
          backgroundImage:
            'linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px), linear-gradient(#fff 1.5px, transparent 1.5px), linear-gradient(90deg, #fff 1.5px, transparent 1.5px)',
          backgroundSize: '26px 26px, 26px 26px, 130px 130px, 130px 130px',
        }}
      />
      {/* breathing warm glow, top-right */}
      <div
        className="s3d-lamp absolute -top-32 -right-20 w-[420px] h-[420px] rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle, rgba(248,113,113,0.22) 0%, rgba(248,113,113,0.07) 45%, transparent 70%)' }}
      />
      {/* plotter scan-line sweeping across */}
      <div
        className="s3d-scan absolute top-0 bottom-0 w-px pointer-events-none"
        style={{ background: 'linear-gradient(to bottom, transparent, rgba(147,197,253,0.55), transparent)' }}
      />
      {/* corner registration ticks */}
      {[['top-3 left-3', 'border-t-2 border-l-2'], ['top-3 right-3', 'border-t-2 border-r-2'], ['bottom-3 left-3', 'border-b-2 border-l-2'], ['bottom-3 right-3', 'border-b-2 border-r-2']].map(([pos, b]) => (
        <div key={pos} className={`absolute ${pos} w-4 h-4 ${b} border-blue-300/40 pointer-events-none`} />
      ))}

      <div className="relative z-10 px-5 sm:px-8 py-6 sm:py-7 flex flex-col md:flex-row items-center gap-4 md:gap-6">
        <div className="flex-1 text-center md:text-left">
          <p className="s3d-rise text-[10px] sm:text-[11px] uppercase tracking-[0.22em] text-blue-300/80 font-bold mb-1.5">
            SOTYN.AI · Secured Engineers
          </p>
          <h2 className="s3d-rise text-2xl sm:text-3xl font-extrabold text-white tracking-tight" style={{ animationDelay: '90ms' }}>
            {greeting}, {name} <span className="align-middle">👋</span>
          </h2>
          <p className="s3d-rise text-sm text-blue-200/80 mt-1" style={{ animationDelay: '180ms' }}>{dateLabel}</p>
        </div>
        {/* floating 3D model — real perspective on the parent so the keyframed
            rotateX/Y foreshorten instead of just skewing */}
        <div className="w-40 sm:w-52 h-28 sm:h-36 flex-shrink-0 [perspective:900px]">
          <div className="s3d-float w-full h-full [transform-style:preserve-3d]">
            <IsoTower />
          </div>
        </div>
      </div>
    </div>
  );
}
