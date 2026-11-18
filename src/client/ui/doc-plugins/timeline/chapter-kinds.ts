/** How each kind of chapter looks and is described. Colours are not per kind: chapters take the palette in turn. */
import type { ChapterKind } from '../../../../shared/schemas/timeline';
import { MATERIAL_CATEGORICAL } from '../../common/categorical-colors';

export const CHAPTER_KIND_META: Record<ChapterKind, { label: string; icon: string; hint: string }> = {
  place: { label: 'Place', icon: 'home', hint: 'Where you lived' },
  people: { label: 'People', icon: 'group', hint: 'Who you were with' },
  pursuit: { label: 'Pursuit', icon: 'work', hint: 'What your days went into: a school, a job, a team' },
  phase: { label: 'Phase', icon: 'hourglass_top', hint: 'A stage of life: new parent, the pandemic, a year abroad' },
  other: { label: 'Other', icon: 'bookmark', hint: 'Any other stretch of your life' },
};

/** A chapter's colour from its position in start order (chapters.ts `colorIndex`), round-robin. */
export function chapterColor(colorIndex: number): string {
  return MATERIAL_CATEGORICAL[colorIndex % MATERIAL_CATEGORICAL.length];
}
