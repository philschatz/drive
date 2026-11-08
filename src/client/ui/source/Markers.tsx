/**
 * Rich-text markers, made visible and editable on a phone.
 *
 * Marks and block markers live inside the Automerge text object and are absent
 * from the JSON projection the rest of the inspector renders — they arrive as
 * spans through the `allRichText` side channel and become discrete
 * {@link DocMarker}s. This module shows them twice: {@link MarkedText} paints
 * them over the value, and {@link MarkerSheet} edits one of them.
 *
 * The predecessor showed each marker as a row of up to seven bare cells whose
 * only labels were `title` tooltips, click-to-edit, saving on Enter and
 * discarding on blur. None of that is reachable by touch, so every field is now a
 * named row in a PropertySheet with an explicit Cancel/Save.
 */
import { useMemo } from 'preact/hooks';
import { PropertySheet, SheetActionItem, SheetActions, type PropertyDef } from '../common/PropertySheet';
import { FieldEditor, GroupEditor } from '../common/FieldEditor';
import { MdTextField } from '@/components/ui/md-text-field';
import type { ValidationError } from '../../../shared/schemas';
import { markerEditOps, type DocMarker, type RichTextOp } from '../../../shared/rich-text-ops';
import { blockChipLabel, escapeString, footnoteLabel, reparseMarkValue, type Path } from './source-nodes';
import './source.css';
import { createLogger } from '../../../shared/logger';

const log = createLogger('source');

export const markerStart = (m: DocMarker) => (m.kind === 'block' ? m.index : m.start);
export const markerName = (m: DocMarker) => (m.kind === 'block' ? m.block.type : m.name);

/**
 * A marker's colour follows its TYPE, so every bold run and every heading look
 * the same wherever they fall — a page of markers then reads by colour, where a
 * colour per position only told two neighbours apart. The palette is a fixed,
 * colourblind-validated eight (`--src-marker-*` in source.css), handed out
 * round-robin over the types: the known vocabulary first, in a fixed order, so a
 * heading is the same colour in every document, then anything else by first
 * appearance in this field. Two types may share a hue; what keeps them apart —
 * and keeps apart a hue pair that colour-vision deficiency merges — is the second
 * channel, the LINE: a run's underline and a chip's border cycle
 * solid/dotted/dashed with a period coprime to the palette's, so no colour+line
 * pair repeats before 24 types.
 */
export type LineStyle = 'solid' | 'dotted' | 'dashed';
export interface MarkerSlot { color: number; line: LineStyle }
export const MARKER_COLORS = 8;
const LINE_STYLES: LineStyle[] = ['solid', 'dotted', 'dashed'];
const KNOWN_TYPES = [
  'paragraph', 'heading', 'unordered-list-item', 'ordered-list-item', 'blockquote', 'divider', 'table-cell',
  'strong', 'em', 'link',
];

/** The slot of every type among `markers` — the same marker always gets the same answer. */
export function markerSlots(markers: DocMarker[]): (m: DocMarker) => MarkerSlot {
  const index = new Map<string, number>(KNOWN_TYPES.map((t, i) => [t, i]));
  for (const m of markers) {
    const name = markerName(m);
    if (!index.has(name)) index.set(name, index.size);
  }
  return (m) => {
    const k = index.get(markerName(m)) ?? index.size;
    return { color: k % MARKER_COLORS, line: LINE_STYLES[k % LINE_STYLES.length] };
  };
}

/** The classes painting a slot: `src-mk-c3 src-mk-dotted` (see source.css). */
export const markerClass = (s: MarkerSlot) => `src-mk-c${s.color} src-mk-${s.line}`;

/** Row headline for a marker: `strong` or `¶ heading`. */
export function markerHeadline(m: DocMarker): string {
  return m.kind === 'block' ? `¶ ${m.block.type}` : m.name;
}

/** Row supporting text: everything else the marker holds, in one line. */
export function markerSummary(m: DocMarker): string {
  if (m.kind === 'block') {
    const parents = m.block.parents ?? [];
    const depth = parents.length ? ` · depth ${parents.length}` : '';
    const attrs = Object.keys(m.block.attrs ?? {}).length ? ` · ${JSON.stringify(m.block.attrs)}` : '';
    return `at ${m.index}${depth}${attrs}`;
  }
  const value = typeof m.value === 'string' ? m.value : JSON.stringify(m.value);
  return `[${m.start}, ${m.end}) · ${value}`;
}

/** The validation error about this marker, if the validator raised one. */
export function markerError(
  m: DocMarker, fieldPath: Path, errors: ValidationError[],
): ValidationError | undefined {
  const name = markerName(m);
  const same = (a: Path, b: Path) => a.length === b.length && a.every((s, i) => s === b[i]);
  return errors.find(e =>
    (e.path.length === fieldPath.length + 1 && same(e.path.slice(0, -1), fieldPath) && e.path[fieldPath.length] === name) ||
    (same(e.path, fieldPath) && e.message.includes(`"${name}"`)));
}

/** Which marker's text and row are flashing, and a nonce so a second tap on the
 * same one restarts the flash (it is folded into the element's key). */
export interface Reveal { index: number; nonce: number }

/**
 * The field's text with its markers painted on: each mark's range tinted and
 * underlined in its type's colour and line style, each block marker replaced by
 * a chip naming its type. The footnote NUMBER is not repeated here — the tap
 * that reveals the row is the tie to the numbered list below; colour and line
 * say what KIND of marker it is, there and here alike.
 *
 * Overlapping marks are the reason a run is nested spans — a background tint can
 * only show one of them. Each covering mark is a span of its own drawing its own
 * underline one step lower, so an overlap reads as stacked lines, each in its
 * mark's colour and style.
 *
 * Every painted thing is a tap target that names its marker (`onPick`): a run
 * picks the topmost mark covering it, a footnote badge or chip picks exactly its
 * own. The screen answers by revealing that marker's row below — and, the other
 * way round, `revealed` flashes the text for a row's number tapped down there.
 */
export function MarkedText({ text, markers, onPick, revealed }: {
  text: string;
  markers: DocMarker[];
  onPick?: (index: number) => void;
  revealed?: Reveal | null;
}) {
  /** Tap-target props for marker `i`. Keyboard too: these are buttons in all
   * but element type, which stays a span so the text keeps flowing inline. */
  const pick = (i: number, testId: string) => (onPick ? {
    role: 'button' as const,
    tabIndex: 0,
    'data-testid': testId,
    'data-marker-index': i,
    onClick: (e: MouseEvent) => { e.stopPropagation(); onPick(i); },
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(i); }
    },
  } : { 'data-testid': testId, 'data-marker-index': i });
  const isRevealed = (i: number) => revealed?.index === i;
  const revealKey = (base: string, i: number) => (isRevealed(i) ? `${base}:r${revealed!.nonce}` : base);
  const revealClass = (i: number, cls?: string) =>
    [cls, isRevealed(i) ? 'src-revealed' : undefined].filter(Boolean).join(' ') || undefined;
  const slot = markerSlots(markers);

  const blocks = new Map<number, { marker: DocMarker; i: number }>();
  const cuts = new Set<number>([0, text.length]);
  markers.forEach((m, i) => {
    if (m.kind === 'block') {
      blocks.set(m.index, { marker: m, i });
      cuts.add(m.index); cuts.add(m.index + 1);
    } else {
      cuts.add(m.start); cuts.add(m.end);
    }
  });
  const boundaries = [...cuts].filter(c => c >= 0 && c <= text.length).sort((a, b) => a - b);

  const parts: any[] = [];
  for (let b = 0; b < boundaries.length - 1; b++) {
    const from = boundaries[b];
    const to = boundaries[b + 1];
    if (to <= from) continue;
    const block = blocks.get(from);
    if (block && to === from + 1) {
      parts.push(
        <span
          key={revealKey(String(from), block.i)}
          className={revealClass(block.i, `src-marker-chip ${markerClass(slot(block.marker))}`)}
          {...pick(block.i, 'marker-chip')}
        >
          ¶{blockChipLabel((block.marker as Extract<DocMarker, { kind: 'block' }>).block)}
        </span>,
      );
      continue;
    }
    const covering = markers
      .map((m, i) => ({ m, i }))
      .filter(({ m }) => m.kind === 'mark' && m.start <= from && m.end >= to);
    if (covering.length === 0) {
      parts.push(<span key={from}>{escapeString(text.slice(from, to))}</span>);
      continue;
    }
    // One nested span per covering mark, the later-starting ones inside, each
    // drawing its own underline one step deeper. Depth is capped where the line
    // would leave the line box — three overlapping marks is already the limit of
    // what this app's vocabulary (strong, em, link) can produce.
    let inner: any = escapeString(text.slice(from, to));
    for (let k = covering.length - 1; k >= 1; k--) {
      const { m, i } = covering[k];
      inner = (
        <span
          className={`src-mark-line src-mk-d${Math.min(k, 2)} ${markerClass(slot(m))}`}
          data-testid="mark-line"
          data-marker-index={i}
        >
          {inner}
        </span>
      );
    }
    // A run flashes for any of the marks covering it, since all of them are its.
    const lit = covering.find(({ i }) => isRevealed(i));
    const top = covering[0];
    parts.push(
      <span
        key={lit ? revealKey(String(from), lit.i) : from}
        className={['src-marked-run src-mark-line src-mk-d0', markerClass(slot(top.m)), lit ? 'src-revealed' : '']
          .filter(Boolean).join(' ')}
        {...pick(top.i, 'marked-run')}
      >
        {inner}
      </span>,
    );
  }
  return <span className="src-mono src-text src-string">{parts}</span>;
}

/** A number typed into a position field: null if it isn't one, else in bounds. */
function position(raw: string, textLength: number): number | null {
  const n = Number(raw.trim());
  if (raw.trim() === '' || !Number.isInteger(n)) return null;
  return Math.max(0, Math.min(textLength, n));
}

/**
 * One marker, as a property sheet.
 *
 * Every marker is shown as it is stored, with no notion of which the document
 * type allows: this inspector renders what the document actually contains, and
 * whether that is legal is the validator's answer, arriving as `error`.
 *
 * The range is a {@link GroupEditor} rather than two fields, so widening a mark
 * is one Automerge change (one `unmark` + `mark` pair) instead of two — and so a
 * half-applied range never reaches the document.
 */
export function MarkerSheet({
  open, marker, index, textLength, editable, error, onOps, onClose,
}: {
  open: boolean;
  marker: DocMarker | null;
  /** Footnote index, so the sheet title matches the highlight in the text. */
  index: number;
  textLength: number;
  editable: boolean;
  error?: ValidationError;
  onOps: (ops: RichTextOp[]) => void;
  onClose: () => void;
}) {
  const properties = useMemo<PropertyDef[]>(() => {
    if (!marker) return [];

    /** Apply an edit and leave — every pane here is one whole marker. */
    const apply = (next: DocMarker | null, back: () => void) => {
      try {
        onOps(markerEditOps(marker, next));
      } catch (err: any) {
        log.warn('marker edit rejected:', err?.message ?? err);
      }
      back();
      onClose();
    };

    const textPane = (
      label: string,
      value: string,
      commit: (raw: string, back: () => void) => void,
      opts?: { multiline?: boolean; supportingText?: string },
    ): PropertyDef['render'] => ({ back }) => (
      <FieldEditor
        value={value}
        onSave={(v) => commit(v, back)}
        onCancel={back}
        data-testid={`marker-${label.toLowerCase().replace(/\s+/g, '-')}`}
      >
        {({ value: draft, onInput, save }) => (
          <MdTextField
            label={label}
            value={draft}
            type={opts?.multiline ? 'textarea' : 'text'}
            supportingText={opts?.supportingText}
            data-testid="marker-field"
            onInput={onInput}
            onEnter={save}
          />
        )}
      </FieldEditor>
    );

    if (marker.kind === 'block') {
      return [
        {
          id: 'mk-type', label: 'Block type', icon: 'format_paragraph', transactional: true,
          summary: () => marker.block.type,
          render: textPane('Block type', marker.block.type, (raw, back) => {
            const type = raw.replace(/^¶\s*/, '').trim();
            if (!type || type === marker.block.type) return back();
            apply({ ...marker, block: { ...marker.block, type } }, back);
          }, { supportingText: 'paragraph, heading, unordered-list-item, …' }),
        },
        {
          id: 'mk-index', label: 'Position', icon: 'my_location', transactional: true,
          summary: () => `${marker.index} of ${textLength}`,
          render: textPane('Position', String(marker.index), (raw, back) => {
            const n = position(raw, textLength);
            if (n === null || n === marker.index) return back();
            apply({ ...marker, index: n }, back);
          }, { supportingText: 'Offset in the flat text, block markers included' }),
        },
        {
          // A block's nesting depth IS its parents chain, so leaving it out would
          // hide the entire encoding of a nested list.
          id: 'mk-parents', label: 'Parents', icon: 'account_tree', transactional: true,
          summary: () => JSON.stringify(marker.block.parents ?? []),
          render: textPane('Parents', JSON.stringify(marker.block.parents ?? []), (raw, back) => {
            let parents: any;
            try { parents = JSON.parse(raw); } catch { return back(); }
            if (!Array.isArray(parents) || parents.some(p => typeof p !== 'string')) return back();
            apply({ ...marker, block: { ...marker.block, parents } }, back);
          }, { supportingText: 'The nesting chain, as a JSON array of block types' }),
        },
        {
          id: 'mk-attrs', label: 'Attrs', icon: 'tune', transactional: true,
          summary: () => JSON.stringify(marker.block.attrs ?? {}),
          render: textPane('Attrs', JSON.stringify(marker.block.attrs ?? {}), (raw, back) => {
            let attrs: any;
            try { attrs = JSON.parse(raw); } catch { return back(); }
            if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) return back();
            apply({ ...marker, block: { ...marker.block, attrs } }, back);
          }, { multiline: true, supportingText: 'Type-specific attributes, as a JSON object' }),
        },
      ];
    }

    return [
      {
        id: 'mk-name', label: 'Mark name', icon: 'label', transactional: true,
        summary: () => marker.name,
        render: textPane('Mark name', marker.name, (raw, back) => {
          const name = raw.trim();
          if (!name || name === marker.name) return back();
          apply({ ...marker, name }, back);
        }, { supportingText: 'strong, em, link, …' }),
      },
      {
        id: 'mk-range', label: 'Range', icon: 'straighten', transactional: true,
        summary: () => `[${marker.start}, ${marker.end})`,
        // One draft over both ends, so widening a mark is a single change.
        render: ({ back }) => (
          <GroupEditor
            value={{ start: String(marker.start), end: String(marker.end) }}
            onSave={({ start, end }) => {
              const s = position(start, textLength);
              const e = position(end, textLength);
              if (s === null || e === null || s > e) return back();
              if (s === marker.start && e === marker.end) return back();
              apply({ ...marker, start: s, end: e }, back);
            }}
            onCancel={back}
            data-testid="marker-range"
          >
            {({ draft, patch }) => (
              <div className="flex gap-2">
                <MdTextField
                  label="Start" value={draft.start} className="flex-1"
                  data-testid="marker-range-start" onInput={(v) => patch({ start: v })}
                />
                <MdTextField
                  label="End" value={draft.end} className="flex-1"
                  data-testid="marker-range-end" onInput={(v) => patch({ end: v })}
                />
              </div>
            )}
          </GroupEditor>
        ),
      },
      {
        id: 'mk-value', label: 'Value', icon: 'data_object', transactional: true,
        summary: () => (typeof marker.value === 'string' ? marker.value : JSON.stringify(marker.value)),
        render: textPane(
          'Value',
          typeof marker.value === 'string' ? marker.value : JSON.stringify(marker.value),
          (raw, back) => apply({ ...marker, value: reparseMarkValue(marker.value, raw) }, back),
          { supportingText: 'Automerge mark values are scalars — a link stores its JSON as text' },
        ),
      },
    ];
  }, [marker, textLength, onOps, onClose]);

  if (!marker) return null;

  return (
    <PropertySheet
      open={open}
      title={`${footnoteLabel(index)} · ${markerHeadline(marker)}`}
      data-testid="marker-sheet"
      properties={editable ? properties : properties.map(p => ({ ...p, render: undefined }))}
      onClose={onClose}
      banner={error ? (
        <div className="src-warn md-body-medium px-3 py-2" data-testid="marker-banner">
          {error.message}
        </div>
      ) : undefined}
      footer={editable ? (
        <SheetActions>
          <SheetActionItem
            icon="delete" label="Delete marker" destructive data-testid="marker-delete"
            onClick={() => {
              try {
                onOps(markerEditOps(marker, null));
              } catch (err: any) {
                log.warn('marker delete rejected:', err?.message ?? err);
              }
              onClose();
            }}
          />
        </SheetActions>
      ) : undefined}
    />
  );
}
