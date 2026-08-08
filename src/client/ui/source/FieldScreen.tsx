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
import { useMemo, useState } from 'preact/hooks';
import { Button } from '@/components/ui/button';
import { PeerDot } from '../common/PeerDot';
import { peerDisplayName, peerIdentityKey } from '../common/presence';
import { usePeerTransports } from '../worker-api';
import type { ValidationError } from '../../../shared/schemas';
import { markersFromSpans, type DocMarker, type RichTextOp, type RichTextSpan } from '../../../shared/rich-text-ops';
import { escapeString, pathsEqual, type Path } from './source-nodes';
import {
  MarkedText, MarkerSheet, footnoteLabel, markerColor, markerError, markerHeadline, markerSummary,
} from './Markers';
import { ValueSheet } from './ValueSheets';
import type { PeerFocus } from './LevelList';
import './source.css';

export function FieldScreen({
  fieldPath, text, spans, editable, errors, peerFocusedPaths, onOps, onSetText,
}: {
  fieldPath: Path;
  /** The flat text, block markers included as `￼`. */
  text: string;
  spans: RichTextSpan[];
  editable: boolean;
  errors: ValidationError[];
  peerFocusedPaths: PeerFocus[];
  onOps: (path: Path, ops: RichTextOp[]) => void;
  /** The new flat text, unescaped — diffed into ops by the caller. */
  onSetText: (path: Path, next: string) => void;
}) {
  const transports = usePeerTransports();
  const [markerIndex, setMarkerIndex] = useState<number | null>(null);
  const [editingText, setEditingText] = useState(false);

  const markers = useMemo<DocMarker[]>(() => markersFromSpans(spans), [spans]);
  const fieldErrors = errors.filter(e => pathsEqual(e.path, fieldPath));
  const peer = peerFocusedPaths.find(p => pathsEqual(p.path, fieldPath));
  const selected = markerIndex === null ? null : markers[markerIndex] ?? null;

  return (
    <div data-testid="source-field">
      {fieldErrors.length > 0 && (
        <div className="src-warn md-body-medium px-3 py-2 mt-2" data-testid="field-errors">
          {fieldErrors.map((e, i) => <div key={i}>{e.message}</div>)}
        </div>
      )}

      <div className="mt-2 rounded-xl bg-surface-container-low p-3" data-testid="field-text">
        {text.length > 0
          ? <MarkedText text={text} markers={markers} />
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
            return (
              <md-list-item
                key={`${markerHeadline(m)}-${i}`}
                type="button"
                data-testid="marker-row"
                onClick={() => setMarkerIndex(i)}
              >
                {/* The footnote number and colour are the tie back to the
                    highlight above — same index, same colour, both directions. */}
                <span slot="start" className="src-footnote w-5 text-center" style={{ color: markerColor(i) }}>
                  {footnoteLabel(i)}
                </span>
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
        value={escapeString(text)}
        multiline
        // `￼` is not decoration: typing one splits a block, deleting one joins.
        supportingText="￼ is a block marker — add or remove one to split or join a block"
        onSave={(raw) => onSetText(fieldPath, raw)}
        onClose={() => setEditingText(false)}
      />
    </div>
  );
}
