import {
  GENERIC_EMOTIONS, EMOTION_GROUPS, VOCABULARY_KEYS, EMOTION_KEY_RE, normalizeEmotion, parseEmotion, emotionLabel, sortEmotions,
} from './emotions';

describe('emotions', () => {
  it('every vocabulary key is a valid, unique key that splits on ":"', () => {
    for (const k of VOCABULARY_KEYS) expect(k).toMatch(EMOTION_KEY_RE);
    expect(new Set(VOCABULARY_KEYS).size).toBe(VOCABULARY_KEYS.length);
    expect(VOCABULARY_KEYS).toContain('self-evaluative:imposter');
    expect(VOCABULARY_KEYS).toContain('moral:guilty');
    expect(VOCABULARY_KEYS.slice(0, GENERIC_EMOTIONS.length)).toEqual([...GENERIC_EMOTIONS]);
    expect(parseEmotion('self-evaluative:imposter')).toEqual({ path: ['self-evaluative', 'imposter'], group: EMOTION_GROUPS[2] });
    expect(parseEmotion('sad')).toEqual({ path: ['sad'], group: undefined });
  });

  it('turns typed text into a key, or nothing', () => {
    expect(normalizeEmotion('Relational: Left out')).toBe('relational:left-out');
    expect(normalizeEmotion('  Proud ')).toBe('proud');
    expect(normalizeEmotion('Temporal:Nostalgic:for College!')).toBe('temporal:nostalgic:for-college');
    expect(normalizeEmotion('Émue')).toBe('emue');
    for (const bad of ['', '  ', 'a::b', ':x', 'a:b:c:d', '!!!']) expect(normalizeEmotion(bad)).toBeNull();
  });

  it('labels a key by its emotion and any nuance', () => {
    expect(emotionLabel('sad')).toBe('Sad');
    expect(emotionLabel('anticipatory:hopeful')).toBe('Hopeful');
    expect(emotionLabel('relational:left-out')).toBe('Left out');
    expect(emotionLabel('temporal:nostalgic:for-college')).toBe('Nostalgic — for college');
    expect(emotionLabel('sad:homesick')).toBe('Sad — homesick');
  });

  it('sorts by the vocabulary, then the rest alphabetically', () => {
    expect(sortEmotions(['zany', 'moral:guilty', 'sad', 'happy', 'apple:x'])).toEqual(['happy', 'sad', 'moral:guilty', 'apple:x', 'zany']);
  });
});
