/**
 * The question both invite-receiver pages ask before they start anything.
 *
 * Opening a link must not *be* the decision: until the confirm button is tapped
 * nothing has left the device, so cancelling is free — the sharer never learns the
 * link was opened. Once the exchange starts there is no receiver-side veto.
 *
 * Inline rather than a ConfirmSheet: these pages have no content behind a scrim, so
 * a dismissed sheet would leave a blank page with nothing to act on. The page body
 * *is* the question, and the app bar's Close link remains the escape hatch.
 *
 * Deliberately depends on nothing but preact + Button, so tests of it (and of the
 * pages' gate branch) need no worker-api mock — same reasoning as SheetActionItem.
 */

import type { ComponentChildren } from 'preact';
import { Button } from '@/components/ui/button';

interface StartGateProps {
  /** The heading, phrased as a question. */
  question: string;
  /** What confirming will actually do. */
  children: ComponentChildren;
  /** A verb — never "OK". */
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** Rendezvous id, shown truncated so both peers can check they're on one channel. */
  channelId?: string;
  /** `add-friend` | `link-device` — the confirm button is `${testId}-confirm`. */
  testId: string;
}

export function StartGate({
  question, children, confirmLabel, onConfirm, onCancel, channelId, testId,
}: StartGateProps) {
  return (
    <div data-testid={`${testId}-gate`}>
      <h2 className="md-title-medium mb-2">{question}</h2>
      <p className="md-body-medium text-on-surface-variant">{children}</p>
      {channelId && (
        <p className="text-[10px] text-muted-foreground mt-2">
          Channel: <code className="font-mono">{channelId.slice(0, 8)}…</code>
        </p>
      )}
      <div className="flex gap-2 mt-4">
        <Button onClick={onConfirm} data-testid={`${testId}-confirm`}>
          {confirmLabel}
        </Button>
        <Button variant="outline" onClick={onCancel} data-testid={`${testId}-cancel`}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
