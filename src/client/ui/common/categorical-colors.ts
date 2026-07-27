/**
 * Shared categorical color palette, drawn from the classic Material Design
 * palette (500 hues). MD3 has no categorical/rotating tokens — its role tokens
 * are all derived from one seed — so anything that needs "N distinguishable
 * colors" (peer presence dots, formula reference highlights, chart series)
 * indexes into this single list instead of keeping its own ad-hoc set.
 *
 * Hues are ordered so adjacent entries contrast strongly (warm/cool
 * alternation), since consumers typically assign colors sequentially or by
 * hash modulo length. All hues are dark enough to work as text on light
 * surfaces.
 */
/** The palette's orange, also exported for one-off warm accents (streak badge). */
export const MATERIAL_ORANGE = '#ff9800'; // orange 500

export const MATERIAL_CATEGORICAL = [
  '#e91e63', // pink 500
  '#3f51b5', // indigo 500
  MATERIAL_ORANGE,
  '#009688', // teal 500
  '#9c27b0', // purple 500
  '#4caf50', // green 500
  '#795548', // brown 500
  '#2196f3', // blue 500
];
