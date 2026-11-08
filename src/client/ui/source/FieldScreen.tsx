/**
 * A rich-text field's own screen.
 *
 * A `Sentences` document carries one block marker per paragraph, heading and list
 * item, so a page of prose is dozens of markers on a single field. As one row in
 * its parent's level that is hopeless — the predecessor rendered each marker as a
 * `nowrap` row of up to seven unlabelled cells beneath the value, which is what
 * made this screen scroll sideways on a phone. So a marker-carrying string gets a
 * level of its own at `#/source/<id>/<path>`: the text with its markers painted
 * on, then one tappable row per marker.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Button } from '@/components/ui/button';
import { PeerDot } from '../common/PeerDot';
import { peerDisplayName, peerIdentityKey } from '../common/presence';
import { usePeerTransports } from '../worker-api';
import type { ValidationError } from '../../../shared/schemas';
import { markersFromSpans, type DocMarker, type RichTextOp, type RichTextSpan } from '../../../shared/rich-text-ops';
import { footnoteLabel, pathsEqual, type Path } from './source-nodes';
import {
  MarkedText, MarkerSheet, markerClass, markerError, markerHeadline, markerSlots, markerSummary, type Reveal,
} from './Markers';
import { markedText, markedTextOps } from './marker-markup';
import { ValueSheet } from './ValueSheets';
import type { PeerFocus } from './LevelList';
import './source.css';

export function FieldScreen({
  fieldPath, text, spans, editable, errors, peerFocusedPaths, onOps,
}: {
  fieldPath: Path;
  /** The flat text, block markers included as `￼`. */
  text: string;
  spans: RichTextSpan[];
  editable: boolean;
  errors: ValidationError[];
  peerFocusedPaths: PeerFocus[];
  onOps: (path: Path, ops: RichTextOp[]) => void;
}) {
  const transports = usePeerTransports();
  const [markerIndex, setMarkerIndex] = useState<number | null>(null);
  const [editingText, setEditingText] = useState(false);
  // The text and the list are the same markers twice, tied by footnote number;
  // a tap on either side flashes and scrolls to the other. `where` says which
  // side is the target, so the side that was tapped does not flash itself.
  const [reveal, setReveal] = useState<(Reveal & { where: 'row' | 'text' }) | null>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const revealIn = (where: 'row' | 'text', index: number) =>
    setReveal(r => ({ where, index, nonce: (r?.nonce ?? 0) + 1 }));
  useEffect(() => {
    if (!reveal) return;
    const sel = reveal.where === 'row'
      ? `[data-testid="marker-row"][data-marker-index="${reveal.index}"]`
      : `[data-testid="field-text"] [data-marker-index="${reveal.index}"]`;
    const el = screenRef.current?.querySelector(sel) as HTMLElement | null;
    // Optional call: jsdom has no scrollIntoView.
    el?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  }, [reveal]);

  const markers = useMemo<DocMarker[]>(() => markersFromSpans(spans), [spans]);
  const slot = useMemo(() => markerSlots(markers), [markers]);
  const fieldErrors = errors.filter(e => pathsEqual(e.path, fieldPath));
  const peer = peerFocusedPaths.find(p => pathsEqual(p.path, fieldPath));
  const selected = markerIndex === null ? null : markers[markerIndex] ?? null;

  return (
    <div data-testid="source-field" ref={screenRef}>
      {fieldErrors.length > 0 && (
        <div className="src-warn md-body-medium px-3 py-2 mt-2" data-testid="field-errors">
          {fieldErrors.map((e, i) => <div key={i}>{e.message}</div>)}
        </div>
      )}

      <div className="mt-2 rounded-xl bg-surface-container-low p-3" data-testid="field-text">
        {text.length > 0
          ? (
            <MarkedText
              text={text}
              markers={markers}
              onPick={(i) => revealIn('row', i)}
              revealed={reveal?.where === 'text' ? reveal : null}
            />
          )
          : <span className="text-sm text-muted-foreground">Empty.</span>}
      </div>

      <div className="flex items-center gap-2 mt-2 px-1">
        {editable && (
          <Button variant="outline" data-testid="field-edit-text" onClick={() => setEditingText(true)}>
            Edit text
          </Button>
        )}
        <span className="md-body-medium text-on-surface-variant">
          {text.length} {text.length === 1 ? 'character' : 'characters'}
        </span>
        {peer && (
          <PeerDot
            identityKey={peerIdentityKey(peer.peerId, peer.userGroupId)}
            direct={transports[peer.peerId] === 'direct'}
            label={`${peerDisplayName(peer.peerId, peer.userGroupId)} is editing`}
          />
        )}
      </div>

      <h3 className="text-xs font-semibold uppercase text-muted-foreground mt-4 mb-1 px-2">
        {markers.length} {markers.length === 1 ? 'marker' : 'markers'}
      </h3>

      {markers.length === 0 ? (
        <p className="text-sm text-muted-foreground py-2 px-2">
          This field carries no marks or block markers.
        </p>
      ) : (
        <md-list style={{ background: 'transparent' }}>
          {markers.map((m, i) => {
            const err = markerError(m, fieldPath, errors);
            const lit = reveal?.where === 'row' && reveal.index === i;
            return (
              <md-list-item
                key={lit ? `${markerHeadline(m)}-${i}:r${reveal!.nonce}` : `${markerHeadline(m)}-${i}`}
                type="button"
                data-testid="marker-row"
                data-marker-index={i}
                className={lit ? 'src-revealed' : undefined}
                onClick={() => setMarkerIndex(i)}
              >
                {/* The footnote number is the tie back to the highlight above
                    — and wears the same colour and line, which say the marker's
                    type. Both directions: tapping the number here flashes that
                    text up there, while the rest of the row opens the sheet. */}
                <button
                  type="button"
                  slot="start"
                  className={`src-footnote w-5 text-center ${markerClass(slot(m))}`}
                  data-testid="row-footnote"
                  aria-label={`Show marker ${footnoteLabel(i)} in the text`}
                  onClick={(e: MouseEvent) => { e.stopPropagation(); revealIn('text', i); }}
                >
                  {footnoteLabel(i)}
                </button>
                <div slot="headline" className="src-mono">{markerHeadline(m)}</div>
                <div slot="supporting-text" className="src-mono truncate">{markerSummary(m)}</div>
                <div slot="end" className="flex items-center gap-1.5">
                  {err && (
                    <span
                      className="material-symbols-outlined"
                      data-testid="marker-error"
                      style={{
                        fontSize: 20,
                        color: `var(--md-sys-color-${err.kind === 'warning' || err.kind === 'dependency' ? 'tertiary' : 'error'})`,
                      }}
                      aria-label={err.message}
                      title={err.message}
                    >
                      {err.kind === 'warning' || err.kind === 'dependency' ? 'warning' : 'error'}
                    </span>
                  )}
                  <md-icon aria-hidden="true">chevron_right</md-icon>
                </div>
              </md-list-item>
            );
          })}
        </md-list>
      )}

      <MarkerSheet
        open={selected !== null}
        marker={selected}
        index={markerIndex ?? 0}
        textLength={text.length}
        editable={editable}
        error={selected ? markerError(selected, fieldPath, errors) : undefined}
        onOps={(ops) => onOps(fieldPath, ops)}
        onClose={() => setMarkerIndex(null)}
      />

      <ValueSheet
        open={editingText}
        title={`Edit ${String(fieldPath[fieldPath.length - 1] ?? 'text')}`}
        label="Text"
        value={markedText(text, markers)}
        multiline
        className="src-mono-field"
        // Every marker is a numbered token (see marker-markup.ts): tokens can be
        // moved, copied and deleted, and that is all — what a marker IS is
        // edited in its own sheet.
        supportingText="⟦1 h1⟧ is block marker 1, ⟨2 strong⟩…⟨/2⟩ is mark 2. Move or copy a token to move or duplicate its marker; delete it to remove the marker. The word after the number is a label, not editable."
        onSave={(raw) => onOps(fieldPath, markedTextOps(raw, text, markers))}
        onClose={() => setEditingText(false)}
      />
    </div>
  );
}
