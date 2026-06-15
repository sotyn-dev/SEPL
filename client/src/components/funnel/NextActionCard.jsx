// The one adaptive action surface. Given a lead decision it renders exactly one
// of four bodies — gate (approve/reject/price/send), status (automatic wait with
// an optional manual nudge), capture (one stage's form + save/advance), or the
// terminal good state. Buttons are left-aligned; the primary is disabled while
// busy so a slow send can't fire twice. This is the only place a form mounts.

import { useState } from 'react';
import {
  FiCheck, FiAlertTriangle, FiPhone, FiDollarSign, FiSend,
  FiXCircle, FiRotateCcw, FiClock, FiArrowRight,
} from 'react-icons/fi';
import CaptureFields from './CaptureFields';
import { nextStageKey } from '../../data/l2dPhases';

const GREEN = 'px-3 py-1.5 rounded-md text-xs font-semibold text-white bg-green-600 hover:bg-green-700 disabled:opacity-50';
const RED = 'px-3 py-1.5 rounded-md text-xs font-semibold text-white bg-red-600 hover:bg-red-700 disabled:opacity-50';
const NEUTRAL = 'px-3 py-1.5 rounded-md text-xs font-semibold text-gray-700 bg-white border border-gray-300 hover:bg-gray-50 disabled:opacity-50';

const TONE_BG = {
  amber: 'bg-amber-50 border-amber-200', green: 'bg-green-50 border-green-200',
  red: 'bg-red-50 border-red-200', blue: 'bg-blue-50 border-blue-200', white: 'bg-white border-gray-200',
};
const TONE_ICON = {
  amber: 'text-amber-500', green: 'text-green-600', red: 'text-red-500', blue: 'text-blue-500', white: 'text-gray-400',
};

const GATE = {
  unprocessed:          { tone: 'amber', Icon: FiAlertTriangle, headline: 'Awaiting classification',          instr: "This lead just arrived and hasn't been auto-processed. Read the enquiry, then approve to greet the client or reject." },
  needs_classification: { tone: 'amber', Icon: FiAlertTriangle, headline: 'Review required — genuine enquiry?', instr: "Our AI couldn't decide. Check the enquiry (call the client if needed), then approve or reject." },
  needs_price:          { tone: 'amber', Icon: FiDollarSign,    headline: 'Set a price to quote',              instr: "Valid enquiry, but no catalogue price was found — the client got a 'price on request' greeting. Enter a price, then approve." },
  call:                 { tone: 'blue',  Icon: FiPhone,         headline: 'Client requested a call',           instr: 'The client asked to be called. After the call, approve to greet them or reject.' },
  confirm_order:        { tone: 'blue',  Icon: FiPhone,         headline: 'Call to confirm the order',         instr: 'The client showed interest. Call to confirm, log the outcome, then send bank details — or keep them warm for later.' },
  send_bank:            { tone: 'green', Icon: FiSend,          headline: 'Send bank details',                 instr: 'Order is confirmed. Send your bank details so the client can pay.' },
  rejected:             { tone: 'red',   Icon: FiXCircle,       headline: 'Rejected as junk',                  instr: 'This lead was rejected and is out of the funnel.' },
};

const CAPTURE_HEADLINE = {
  PAYMENT_CONFIRMED: 'Confirm payment received',
  PO_DRAFTED: 'Raise PO to vendor',
  DISPATCH_CONFIRMED: 'Confirm dispatch',
  PURCHASE_BILL: 'Record purchase bill',
  SALES_BILL: 'Record sales bill',
  RECEIPT: 'Record receipt',
};

export default function NextActionCard({ decision, lead, cap, setCap, busy, onAdvance, onSave, onSaveAndAdvance, onSetStage }) {
  const [note, setNote] = useState('');
  const [price, setPrice] = useState('');
  const [armed, setArmed] = useState(false);
  const noteArg = note.trim() || undefined;

  if (decision.mode === 'gate') {
    return <GateCard {...{ decision, lead, note, setNote, price, setPrice, armed, setArmed, busy, onAdvance, noteArg }} />;
  }
  if (decision.mode === 'capture') {
    return <CaptureCard {...{ decision, cap, setCap, busy, onSave, onSaveAndAdvance }} />;
  }
  if (decision.mode === 'terminal_good') {
    return <TerminalCard {...{ cap, setCap, busy, onSave }} />;
  }
  return <StatusCard {...{ decision, note, setNote, busy, onAdvance, onSetStage, noteArg }} />;
}

function Shell({ tone, Icon, eyebrow, headline, children }) {
  return (
    <div className={`rounded-lg border p-3.5 ${TONE_BG[tone]}`}>
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-500 mb-1.5">
        <Icon size={12} className={TONE_ICON[tone]} aria-hidden /> {eyebrow}
      </div>
      <div className="text-sm font-semibold text-gray-900">{headline}</div>
      {children}
    </div>
  );
}

function NoteField({ note, setNote, label = 'Conversation note (optional)' }) {
  return (
    <div className="mt-2.5">
      <label htmlFor="action-note" className="text-[10px] text-gray-500 block mb-0.5">{label}</label>
      <textarea
        id="action-note"
        rows={2}
        className="input input-sm w-full resize-none"
        placeholder="e.g. Called the client — confirmed item & quantity…"
        value={note}
        onChange={e => setNote(e.target.value)}
      />
    </div>
  );
}

function GateCard({ decision, lead, note, setNote, price, setPrice, armed, setArmed, busy, onAdvance, noteArg }) {
  const kind = decision.gateKind;
  const cfg = GATE[kind];
  if (!cfg) return null;

  const approveWelcome = () => onAdvance({ to: 'WELCOME_SENT', send: 'welcome', note: noteArg });
  // Re-send the welcome WITH the real price — a "price on request" customer
  // otherwise never learns it. Server skips it if a priced welcome already went out.
  const savePrice = () => onAdvance({ to: 'WELCOME_SENT', quoted_price: price, send: 'welcome', note: noteArg });
  const sendBank = () => onAdvance({ to: 'BANK_SENT', send: 'bank', note: noteArg });
  const reject = () => {
    if (!note.trim() && !armed) { setArmed(true); return; }
    onAdvance({ to: 'REJECTED', note: note.trim() || 'rejected by coordinator' });
  };
  const showReject = ['unprocessed', 'needs_classification', 'needs_price', 'call'].includes(kind);

  return (
    <Shell tone={cfg.tone} Icon={cfg.Icon} eyebrow="Next Action" headline={cfg.headline}>
      <p className="text-xs text-gray-600 mt-1 leading-relaxed">{cfg.instr}</p>
      {kind === 'needs_classification' && lead.ai_reason && (
        <p className="text-[11px] text-gray-500 mt-1.5 italic">AI: {lead.ai_reason}</p>
      )}

      {kind === 'needs_price' && (
        <div className="mt-2.5">
          <label htmlFor="gate-price" className="text-[10px] text-gray-500 block mb-0.5">Quoted price (₹)</label>
          <input id="gate-price" type="number" min="0" autoFocus className="input input-sm w-full max-w-[180px]"
            placeholder="e.g. 45000" value={price} onChange={e => setPrice(e.target.value)} />
        </div>
      )}

      {kind !== 'rejected' && <NoteField note={note} setNote={setNote} />}

      <div className="flex items-center gap-2 mt-3">
        {(kind === 'unprocessed' || kind === 'needs_classification' || kind === 'call') && (
          <button onClick={approveWelcome} disabled={busy} className={GREEN}>
            <FiCheck className="inline mr-1" size={12} /> Approve &amp; send welcome
          </button>
        )}
        {kind === 'needs_price' && (
          <button onClick={savePrice} disabled={busy || !(Number(price) > 0)} className={GREEN}>
            <FiCheck className="inline mr-1" size={12} /> Save price &amp; approve
          </button>
        )}
        {(kind === 'confirm_order' || kind === 'send_bank') && (
          <button onClick={sendBank} disabled={busy} className={GREEN}>
            <FiSend className="inline mr-1" size={12} /> {kind === 'confirm_order' ? 'Confirm order & send bank' : 'Send bank details'}
          </button>
        )}
        {kind === 'rejected' && (
          <button onClick={() => onAdvance({ to: 'NEEDS_REVIEW', note: 'reopened for review' })} disabled={busy} className={GREEN}>
            <FiRotateCcw className="inline mr-1" size={12} /> Reopen for review
          </button>
        )}
        {kind === 'confirm_order' && (
          <button onClick={() => onAdvance({ to: 'KEEP_IN_TOUCH', note: noteArg })} disabled={busy} className={NEUTRAL}>
            Not ready — nurture
          </button>
        )}
        {showReject && (
          <button onClick={reject} disabled={busy} className={RED}>
            <FiXCircle className="inline mr-1" size={12} />
            {armed && !note.trim() ? 'Click again to confirm' : (kind === 'needs_price' ? 'Reject' : 'Reject as junk')}
          </button>
        )}
      </div>
    </Shell>
  );
}

function StatusCard({ decision, note, setNote, busy, onAdvance, onSetStage, noteArg }) {
  const awaitingReply = decision.stageKey === 'WELCOME_SENT';
  return (
    <Shell tone="blue" Icon={FiClock} eyebrow="In progress"
      headline={awaitingReply ? 'Welcome sent — awaiting customer reply' : 'Bank details sent — awaiting payment'}>
      <p className="text-xs text-gray-600 mt-1 leading-relaxed">
        {awaitingReply
          ? 'The client has been greeted with a price. The funnel advances automatically when they reply on WhatsApp — or confirm the order yourself after a call.'
          : 'Bank details have been shared. Mark the payment received once it lands to continue the dispatch flow.'}
      </p>
      {awaitingReply && <NoteField note={note} setNote={setNote} />}
      <div className="flex items-center gap-2 mt-3">
        {awaitingReply ? (
          <button onClick={() => onAdvance({ to: 'BANK_SENT', send: 'bank', note: noteArg })} disabled={busy} className={GREEN}>
            <FiSend className="inline mr-1" size={12} /> Confirm order &amp; send bank
          </button>
        ) : (
          <button onClick={() => onSetStage('PAYMENT_CONFIRMED')} disabled={busy} className={GREEN}>
            <FiCheck className="inline mr-1" size={12} /> Record payment
          </button>
        )}
      </div>
    </Shell>
  );
}

function CaptureCard({ decision, cap, setCap, busy, onSave, onSaveAndAdvance }) {
  const stageKey = decision.stageKey;
  const next = nextStageKey(stageKey);
  return (
    <Shell tone="white" Icon={FiArrowRight} eyebrow="Next Action" headline={CAPTURE_HEADLINE[stageKey] || 'Capture details'}>
      <div className="mt-2.5 space-y-2">
        <CaptureFields stageKey={stageKey} cap={cap} setCap={setCap} />
      </div>
      <div className="flex items-center gap-2 mt-3">
        <button onClick={() => onSaveAndAdvance(next)} disabled={busy} className={GREEN}>
          <FiCheck className="inline mr-1" size={12} /> Save &amp; advance
        </button>
        <button onClick={onSave} disabled={busy} className={NEUTRAL}>Save</button>
      </div>
    </Shell>
  );
}

function TerminalCard({ cap, setCap, busy, onSave }) {
  return (
    <Shell tone="green" Icon={FiCheck} eyebrow="Done" headline="Deal closed — keeping in touch">
      <p className="text-xs text-gray-600 mt-1 leading-relaxed">
        Periodic follow-up messages keep this relationship warm. Opt the client out to stop them.
      </p>
      <label className="flex items-center gap-2 text-xs mt-2.5">
        <input type="checkbox" checked={!!cap.opted_out} onChange={e => setCap({ ...cap, opted_out: e.target.checked ? 1 : 0 })} />
        Opted out of follow-up messages
      </label>
      <div className="flex items-center gap-2 mt-3">
        <button onClick={onSave} disabled={busy} className={GREEN}>Save</button>
      </div>
    </Shell>
  );
}
