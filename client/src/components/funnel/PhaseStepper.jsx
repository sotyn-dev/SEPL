// The drawer's spine: six human milestones. The current milestone expands into
// the NextActionCard (the one place a form lives); completed milestones collapse
// to a one-line summary that opens to their timestamped log of automatic + manual
// events; future milestones are locked, visual-only (no chevron, no form).

import { useState, useEffect, useRef } from 'react';
import { FiCheck, FiLock, FiChevronDown, FiChevronRight } from 'react-icons/fi';
import {
  PHASES, phaseIndexForStage, phaseIndexForMessage, messageLabel, historyLabel,
} from '../../data/l2dPhases';
import { fmtIST } from '../../utils/dateIST';
import NextActionCard from './NextActionCard';

function phaseLog(idx, history, messages) {
  const items = [];
  history.forEach(h => {
    if (phaseIndexForStage(h.to_stage) === idx) items.push({ t: h.created_at, label: historyLabel(h), note: h.note });
  });
  messages.forEach(m => {
    if (phaseIndexForMessage(m) === idx) items.push({ t: m.created_at, label: messageLabel(m), failed: m.status === 'failed' });
  });
  return items.sort((a, b) => new Date(a.t) - new Date(b.t));
}

export default function PhaseStepper({ lead, decision, history = [], messages = [], cap, setCap, busy, onAdvance, onSave, onSaveAndAdvance, onSetStage }) {
  const current = phaseIndexForStage(lead.stage);
  const [openDone, setOpenDone] = useState(null);
  const currentRef = useRef(null);

  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [current]);

  return (
    <ol className="relative">
      {PHASES.map((p, i) => {
        const status = i < current ? 'done' : i === current ? 'current' : 'future';
        const isLast = i === PHASES.length - 1;
        const log = status === 'future' ? [] : phaseLog(i, history, messages);
        return (
          <PhaseNode
            key={p.id}
            phase={p}
            status={status}
            isLast={isLast}
            log={log}
            nodeRef={status === 'current' ? currentRef : null}
            expandedDone={openDone === i}
            onToggleDone={() => setOpenDone(openDone === i ? null : i)}
          >
            {status === 'current' && (
              <NextActionCard
                decision={decision} lead={lead} cap={cap} setCap={setCap} busy={busy}
                onAdvance={onAdvance} onSave={onSave} onSaveAndAdvance={onSaveAndAdvance} onSetStage={onSetStage}
              />
            )}
          </PhaseNode>
        );
      })}
    </ol>
  );
}

function PhaseNode({ phase, status, isLast, log, nodeRef, expandedDone, onToggleDone, children }) {
  const done = status === 'done';
  const current = status === 'current';

  const dotCls = done
    ? 'bg-green-500 border-green-500 text-white'
    : current
      ? 'bg-blue-600 border-blue-600 text-white ring-4 ring-blue-100'
      : 'bg-white border-gray-300 text-gray-300';

  return (
    <li className="relative pl-8 pb-4" ref={nodeRef}>
      {!isLast && <span className={`absolute left-[11px] top-7 bottom-0 w-px ${done ? 'bg-green-300' : 'bg-gray-200'}`} aria-hidden />}
      <span className={`absolute left-0 top-0.5 flex items-center justify-center w-6 h-6 rounded-full border-2 ${dotCls}`}>
        {done ? <FiCheck size={13} /> : current ? <span className="text-[11px] font-bold">{PHASES.indexOf(phase) + 1}</span> : <FiLock size={11} />}
      </span>

      {/* Header */}
      <button
        type="button"
        onClick={done ? onToggleDone : undefined}
        className={`w-full flex items-center justify-between gap-2 text-left ${done ? 'cursor-pointer' : 'cursor-default'}`}
      >
        <div className="min-w-0">
          <div className={`text-sm font-semibold ${current ? 'text-blue-700' : done ? 'text-gray-700' : 'text-gray-400'}`}>{phase.label}</div>
          <div className="text-[10px] uppercase tracking-wider text-gray-400">{phase.owner}</div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {done && log.length > 0 && <span className="text-[10px] text-gray-400">{fmtIST(log[log.length - 1].t)}</span>}
          {current && <span className="text-[10px] font-medium text-blue-600 uppercase tracking-wider">Now</span>}
          {done && (expandedDone ? <FiChevronDown size={13} className="text-gray-400" /> : <FiChevronRight size={13} className="text-gray-300" />)}
        </div>
      </button>

      {/* Current action */}
      {current && <div className="mt-2">{children}</div>}

      {/* Logged events: always under current, on-demand under done */}
      {((current && log.length > 0) || (done && expandedDone)) && <LogList items={log} muted={current} />}
    </li>
  );
}

function LogList({ items, muted }) {
  if (!items.length) return null;
  return (
    <ul className={`space-y-1 ${muted ? 'mt-2' : 'mt-2'}`}>
      {items.map((it, i) => (
        <li key={i} className="text-[11px] text-gray-500 flex gap-2">
          <span className="text-gray-400 shrink-0">{fmtIST(it.t)}</span>
          <span className={it.failed ? 'text-red-500' : ''}>{it.label}{it.note ? ` — ${it.note}` : ''}</span>
        </li>
      ))}
    </ul>
  );
}
