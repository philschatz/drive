/**
 * Step-by-step progress for an encrypted relay rendezvous.
 *
 * Used by BOTH the sharer (RendezvousShare) and the receiver (AddFriendPage /
 * LinkDevicePage) so each side can see exactly where it is in the exchange:
 *   connect → wait for peer → peer joined → transfer → done
 *
 * The rendezvous id is always shown (short, click-to-copy) so the two devices can
 * confirm they're waiting on the *same* channel when something isn't working.
 */

import { useWsStatus } from '../worker-api';
import type { RendezvousStatus } from '../worker-api';

interface RendezvousProgressProps {
  /** Latest status from onRendezvousEvent, or null before the first event. */
  phase: RendezvousStatus | null;
  /** The shared rendezvous id (shown to both peers). */
  rendezvousId?: string;
  /** Human message for the "waiting for the other peer" step. */
  waitingLabel: string;
  /** Human message for the "exchanging data" step. */
  transferLabel: string;
  /** Human message for the final, completed step. */
  doneLabel: string;
  /** When set, the whole flow is shown as failed with this message. */
  errorMessage?: string | null;
}

type StepState = 'pending' | 'active' | 'done';

/**
 * Index of the *current* step (0-based) for a given phase. A terminal phase
 * returns 5 (past the last index) so every step — including the final "done"
 * row — renders complete rather than leaving it spinning.
 */
function currentStep(phase: RendezvousStatus | null, connected: boolean): number {
  switch (phase) {
    case 'waiting': return 1;
    case 'peer-joined': return 2;
    case 'sending':
    case 'receiving': return 3;
    case 'sent':
    case 'received':
    case 'linked': return 5;
    default: return connected ? 1 : 0; // no event yet
  }
}

function StepRow({ state, label }: { state: StepState; label: string }) {
  const icon =
    state === 'done' ? 'check_circle'
    : state === 'active' ? 'progress_activity'
    : 'radio_button_unchecked';
  const color =
    state === 'done' ? 'text-green-600'
    : state === 'active' ? 'text-primary'
    : 'text-muted-foreground/40';
  const textColor = state === 'pending' ? 'text-muted-foreground/60' : 'text-foreground';
  return (
    <div className="flex items-center gap-2">
      <span
        className={`material-symbols-outlined ${color} ${state === 'active' ? 'animate-spin' : ''}`}
        style={{ fontSize: 18 }}
      >
        {icon}
      </span>
      <span className={`text-xs ${textColor}`}>{label}</span>
    </div>
  );
}

export function RendezvousProgress({
  phase, rendezvousId, waitingLabel, transferLabel, doneLabel, errorMessage,
}: RendezvousProgressProps) {
  const connected = useWsStatus('');

  const idRow = rendezvousId ? (
    <p className="text-[10px] text-muted-foreground pt-1">
      Channel:{' '}
      <code
        className="font-mono cursor-pointer hover:text-foreground"
        title={`${rendezvousId} (click to copy)`}
        onClick={() => navigator.clipboard.writeText(rendezvousId)}
      >
        {rendezvousId.slice(0, 8)}…
      </code>
    </p>
  ) : null;

  if (errorMessage) {
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-destructive" style={{ fontSize: 18 }}>error</span>
          <span className="text-xs text-destructive">{errorMessage}</span>
        </div>
        {idRow}
      </div>
    );
  }

  const cur = currentStep(phase, connected);
  const steps: { label: string }[] = [
    { label: connected ? 'Connected to relay' : 'Connecting to relay…' },
    { label: waitingLabel },
    { label: 'Other device connected' },
    { label: transferLabel },
    { label: doneLabel },
  ];

  const stateFor = (i: number): StepState =>
    cur >= steps.length ? 'done' : i < cur ? 'done' : i === cur ? 'active' : 'pending';

  return (
    <div className="space-y-1.5">
      {steps.map((s, i) => (
        <StepRow key={i} state={stateFor(i)} label={s.label} />
      ))}
      {idRow}
    </div>
  );
}
