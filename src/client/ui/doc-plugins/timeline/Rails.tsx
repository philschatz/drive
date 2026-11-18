/**
 * The gutter left of every timeline row: one lane per chapter that can be
 * under way at once, and in each lane the piece of that chapter's bar that
 * crosses this row. Rows sit flush against each other, so the pieces join
 * into continuous vertical bars down the list.
 *
 * The list is newest first, so a bar runs UP from its chapter's own row
 * (`start`: top edge to a dot in the middle) to the newest row inside it
 * (`end`: middle to bottom edge), through everything between. A piece the
 * chapter only possibly covers (a fuzzy end) is faded.
 */
import type { CellShape } from '../../../../shared/timeline/chapters';

export const LANE_PX = 10;
const PAD_PX = 4;
const BAR_PX = 3;
const DOT_PX = 9;

export interface RailCell {
  uid: string;
  lane: number;
  color: string;
  /** `between`: drawn on something between rows (header, gap, insert target) — always full height. */
  shape: CellShape | 'between';
  maybe: boolean;
  title: string;
}

export function railsWidth(lanes: number): number {
  return lanes ? lanes * LANE_PX + PAD_PX : 0;
}

export function Rails({ lanes, cells, onOpen }: {
  lanes: number;
  cells: RailCell[];
  onOpen?: (uid: string) => void;
}) {
  if (!lanes) return null;
  return (
    <div className="relative shrink-0 self-stretch" style={{ width: `${railsWidth(lanes)}px` }} aria-hidden="true" data-testid="rails">
      {cells.map(c => {
        const left = PAD_PX + c.lane * LANE_PX;
        const line = c.shape === 'start' ? { top: 0, bottom: '50%' }
          : c.shape === 'end' ? { top: '50%', bottom: 0 }
          : c.shape === 'dot' ? null
          : { top: 0, bottom: 0 };
        const dot = c.shape === 'start' || c.shape === 'dot';
        return (
          <button
            key={c.uid}
            type="button"
            tabIndex={-1}
            title={c.title}
            data-chapter={c.uid}
            data-lane={c.lane}
            data-shape={c.shape}
            data-maybe={c.maybe ? '' : undefined}
            className="absolute top-0 bottom-0 p-0 border-0 bg-transparent cursor-pointer"
            style={{ left: `${left}px`, width: `${LANE_PX}px`, opacity: c.maybe ? 0.4 : 1 }}
            onClick={e => { e.stopPropagation(); onOpen?.(c.uid); }}
          >
            {line && (
              <span className="absolute" style={{
                ...line, left: `${(LANE_PX - BAR_PX) / 2}px`, width: `${BAR_PX}px`, background: c.color,
                borderRadius: c.shape === 'end' ? `${BAR_PX}px ${BAR_PX}px 0 0` : undefined,
              }} />
            )}
            {dot && (
              <span className="absolute rounded-full" style={{
                top: `calc(50% - ${DOT_PX / 2}px)`, left: `${(LANE_PX - DOT_PX) / 2}px`,
                width: `${DOT_PX}px`, height: `${DOT_PX}px`, background: c.color,
              }} />
            )}
          </button>
        );
      })}
    </div>
  );
}
