import Slider from '../../components/Slider';
import {
  FiGitBranch, FiUser, FiTag, FiShield, FiStar, FiX, FiLayers, FiUserPlus, FiCornerDownRight,
} from 'react-icons/fi';

// Org Structure — the in-app guide. Illustrated slide cards handed to the
// reusable <Slider/>, itself hosted inside the shared <Modal/> (see OrgStructure).
// The visuals are rebuilt from the real UI so the guide looks like the thing it
// explains.

function Slide({ icon, eyebrow, title, children }) {
  return (
    <div className="px-1 pb-1">
      <div className="flex items-center gap-2 mb-1">
        <span className="w-8 h-8 rounded-lg bg-red-50 text-red-600 flex items-center justify-center flex-shrink-0">{icon}</span>
        <span className="text-[11px] font-bold uppercase tracking-wide text-red-500">{eyebrow}</span>
      </div>
      <h3 className="text-lg font-bold text-gray-900 mb-3">{title}</h3>
      <div className="text-sm text-gray-600 leading-relaxed">{children}</div>
    </div>
  );
}

// ── little building blocks that mirror the real tree ──
const Lbl = ({ tone = 'gray', children }) => (
  <span className={`text-[9px] font-bold uppercase tracking-wide flex-shrink-0 ${tone === 'blue' ? 'text-blue-400' : 'text-gray-400'}`}>{children}</span>
);
const SDot = ({ tone }) => {
  const c = { present: 'bg-green-500', planned: 'bg-amber-400', not: 'bg-gray-300' }[tone] || 'bg-green-500';
  return <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${c}`} />;
};
const Kebab = () => <span className="ml-auto text-gray-300 font-bold tracking-widest text-xs leading-none">⋮</span>;

function DRow({ tone, name, tag, star }) {
  return (
    <div className="flex items-center gap-2 text-[13px] text-gray-700 px-1 py-0.5 rounded">
      <SDot tone={tone} /><span className="truncate">{name}</span>
      {tag && <span className="text-gray-400">· {tag}</span>}
      {star && <FiStar className="text-amber-400 flex-shrink-0" size={11} />}
      <FiX className="ml-auto text-gray-300 flex-shrink-0" size={12} />
    </div>
  );
}
function HeadRow({ who, title }) {
  return (
    <div className="flex items-center gap-1.5 text-[13px]">
      <Lbl tone="blue">Head</Lbl><span className="font-semibold text-gray-800">{who}</span>
      <span className="text-gray-300">·</span><span className="text-gray-500">{title}</span>
    </div>
  );
}

export default function OrgStructureGuide() {
  return (
    <Slider showCount stickyFooter ariaLabel="Org Structure guide" className="min-h-[380px]">

      {/* 1 — mental model, with a two-fact diagram */}
      <Slide icon={<FiGitBranch />} eyebrow="The model" title="One shape, all the way down">
        <p className="mb-3">The organisation is a recursive tree. Every node carries the same two orthogonal facts:</p>
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-xl border border-blue-100 bg-blue-50/40 p-3">
            <div className="flex items-center gap-1.5 mb-1"><FiUser className="text-blue-500" size={14} /><span className="text-[11px] font-bold uppercase tracking-wide text-blue-500">Head</span></div>
            <p className="text-[13px] text-gray-600">One person who leads it. Display-only — grants no access.</p>
          </div>
          <div className="rounded-xl border border-green-100 bg-green-50/40 p-3">
            <div className="flex items-center gap-1.5 mb-1"><FiTag className="text-green-600" size={14} /><span className="text-[11px] font-bold uppercase tracking-wide text-green-600">Designations</span></div>
            <p className="text-[13px] text-gray-600">The titles that unit holds, drawn from the shared catalog.</p>
          </div>
        </div>
        <p className="mt-3">On the <b>root</b>, designations are called <b className="text-red-600">Org roles</b> — company-wide titles reporting to the head in no department (EA&nbsp;to&nbsp;MD, Company Secretary).</p>
      </Slide>

      {/* 2 — the tree, rebuilt */}
      <Slide icon={<FiLayers />} eyebrow="Departments tab" title="Reading the tree">
        <div className="rounded-xl border border-gray-200 bg-white p-3 mb-3">
          {/* root */}
          <div className="flex items-center gap-2 px-1 py-1">
            <span className="text-gray-400 text-xs">⌄</span>
            <span className="font-bold text-gray-900 text-sm">Secured Engineers</span>
            <span className="text-[11px] text-gray-400">SEPL</span>
            <span className="w-1.5 h-1.5 rounded-full bg-green-500" /><Kebab />
          </div>
          <div className="border-l-2 border-gray-100 ml-5 pl-3 space-y-1.5 py-1">
            <HeadRow who="Ravi Kumar" title="MD" />
            <div>
              <Lbl>Org roles</Lbl>
              <div className="mt-1"><DRow tone="present" name="EA to MD" /></div>
            </div>
          </div>
          {/* business */}
          <div className="ml-5">
            <div className="flex items-center gap-2 px-1 py-1">
              <span className="text-gray-400 text-xs">⌄</span><span className="font-semibold text-gray-800 text-sm">Business</span>
              <span className="w-1.5 h-1.5 rounded-full bg-green-500" /><Kebab />
            </div>
            <div className="border-l-2 border-gray-100 ml-5 pl-3 space-y-1.5 py-1">
              <HeadRow who="Ravi Kumar" title="CFO" />
              <div>
                <Lbl>Designations</Lbl>
                <div className="mt-1 space-y-0.5">
                  <DRow tone="present" name="Chief Financial Officer" tag="CFO" star />
                  <DRow tone="planned" name="Area Sales Manager" tag="ASM" />
                </div>
              </div>
            </div>
            {/* operation, collapsed */}
            <div className="flex items-center gap-2 px-1 py-1">
              <span className="text-gray-400 text-xs inline-block -rotate-90">⌄</span><span className="font-semibold text-gray-800 text-sm">Operation</span>
              <span className="w-1.5 h-1.5 rounded-full bg-green-500" /><span className="text-[11px] text-gray-400 ml-1">2 desig.</span><Kebab />
            </div>
          </div>
        </div>
        <ul className="text-[13px] text-gray-500 space-y-1">
          <li><b className="text-gray-700">Head</b> shows the tag (hover → full title). <b className="text-gray-700">Status dot:</b> <span className="text-green-600">present</span> · <span className="text-amber-600">planned</span> · <span className="text-gray-400">not wanted</span>. Folded nodes show a hint.</li>
        </ul>
      </Slide>

      {/* 3 — heads: a mock of the person-only picker */}
      <Slide icon={<FiUserPlus />} eyebrow="Set head" title="Heads reference, never author">
        <div className="rounded-xl border border-gray-200 bg-white p-3 mb-3 max-w-[380px]">
          <div className="text-[10px] font-mono uppercase tracking-wide text-gray-400 mb-1">Person</div>
          <div className="flex items-center gap-2 border border-gray-200 rounded-lg px-2.5 py-2">
            <span className="w-6 h-6 rounded-full bg-red-600 text-white text-[10px] font-bold flex items-center justify-center">RK</span>
            <span className="text-sm text-gray-800">Ravi Kumar</span>
            <span className="ml-auto text-gray-300">⌄</span>
          </div>
          <p className="text-[11px] text-gray-400 mt-2">↑ one field only — no designation picker here.</p>
        </div>
        <p><b>Set head</b> records only <em>who</em> leads, picked from existing employees. It never creates or edits an employee. The title shown beside a head is <b>read-only</b> from that person's own record — editing it is an employee-record job, not the tree's.</p>
      </Slide>

      {/* 4 — designations: multi-select + rules */}
      <Slide icon={<FiTag />} eyebrow="Designations tab" title="The catalog is the source of truth">
        <div className="rounded-xl border border-gray-200 bg-white p-2 mb-3 max-w-[420px]">
          <div className="flex items-center justify-between px-1 pb-1">
            <span className="text-[10px] font-mono uppercase tracking-wide text-gray-400">Pick from the catalog</span>
            <span className="text-[11px] font-medium text-red-600">+ New designation…</span>
          </div>
          {[['Chief Operating Officer', 'COO', true, true], ['EA to MD', null, true, false], ['Site Supervisor', null, false, false]].map(([n, t, checked, star]) => (
            <div key={n} className={`flex items-center gap-2 px-2 py-1.5 rounded ${checked ? 'bg-red-50/50' : ''}`}>
              <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center text-[9px] ${checked ? 'bg-red-600 border-red-600 text-white' : 'border-gray-300'}`}>{checked ? '✓' : ''}</span>
              <span className="text-[13px] text-gray-800">{n}</span>
              {t && <span className="badge badge-gray !normal-case !tracking-normal !text-[10px]">{t}</span>}
              {star && <FiStar className="text-amber-500" size={12} />}
            </div>
          ))}
        </div>
        <p className="mb-2"><b>Add designation</b> is a multi-select — tick several, attach at once. <b>+ New designation</b> routes to the full form so a tag and the <FiStar className="inline text-amber-500" size={11} /> unique flag are never skipped.</p>
        <p className="text-[13px] text-gray-500">No case duplicates: <code className="text-xs bg-gray-100 px-1 rounded">MD</code> = <code className="text-xs bg-gray-100 px-1 rounded">md</code> = <code className="text-xs bg-gray-100 px-1 rounded">Md</code>, and “Managing Director” = “managing director”. First casing wins.</p>
      </Slide>

      {/* 5 — safety: the compact confirm + validation */}
      <Slide icon={<FiShield />} eyebrow="Guarantees" title="The forms keep you safe">
        <div className="grid sm:grid-cols-2 gap-3 mb-3">
          {/* confirm dialog */}
          <div className="rounded-xl border border-gray-200 shadow-sm overflow-hidden">
            <div className="px-3 py-2 border-b border-gray-100"><span className="text-[13px] font-semibold text-gray-800">Remove designation</span></div>
            <div className="px-3 py-2.5 text-[13px] text-gray-600">Remove “COO” from this department?</div>
            <div className="flex justify-end gap-2 px-3 pb-2.5">
              <span className="px-2.5 py-1 text-xs rounded-lg border border-gray-300 text-gray-600">Cancel</span>
              <span className="px-2.5 py-1 text-xs rounded-lg bg-red-600 text-white">Remove</span>
            </div>
          </div>
          {/* validation */}
          <div className="rounded-xl border border-gray-200 p-3">
            <div className="text-[10px] font-mono uppercase tracking-wide text-gray-400 mb-1">Full title <span className="text-red-500">*</span></div>
            <div className="border border-red-400 rounded-lg px-2.5 py-2 text-sm text-gray-400">Managing Director</div>
            <p className="text-[11px] text-red-500 mt-1">Full title is required.</p>
            <div className="flex justify-end mt-2"><span className="px-3 py-1 text-xs rounded-lg bg-red-300 text-white cursor-not-allowed">Save</span></div>
          </div>
        </div>
        <ul className="text-[13px] text-gray-600 space-y-1">
          <li className="flex gap-2"><FiCornerDownRight className="text-gray-300 mt-0.5 flex-shrink-0" size={13} /><span><b>Ask first</b> — detach, delete & deactivate route through the compact confirm. No silent removal.</span></li>
          <li className="flex gap-2"><FiCornerDownRight className="text-gray-300 mt-0.5 flex-shrink-0" size={13} /><span><b>Save stays disabled</b> until required fields are valid.</span></li>
        </ul>
        <p className="text-gray-400 text-xs pt-2">← / → or swipe to move between slides.</p>
      </Slide>
    </Slider>
  );
}
