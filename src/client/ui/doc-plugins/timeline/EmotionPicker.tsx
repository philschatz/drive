/**
 * Pick how an entry felt: the vocabulary's emotions as toggle chips, generic
 * first then by category, plus a field for your own key
 * (shared/timeline/emotions.ts). Controlled: `value` is the chosen keys and
 * `onChange` gets the next set; nothing is written until the pane saves.
 * Used by the Feelings pane and by the new-entry pane.
 */
import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { MdTextField } from '@/components/ui/md-text-field';
import {
  GENERIC_EMOTIONS, EMOTION_GROUPS, VOCABULARY_KEYS, normalizeEmotion, emotionLabel, sortEmotions,
} from '../../../../shared/timeline/emotions';

export function EmotionPicker({ value, onChange }: {
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const [own, setOwn] = useState('');
  const toggle = (k: string) => onChange(value.includes(k) ? value.filter(x => x !== k) : [...value, k]);
  const typed = normalizeEmotion(own);
  const add = () => {
    if (!typed) return;
    if (!value.includes(typed)) onChange([...value, typed]);
    setOwn('');
  };

  const chip = (k: string, label: string) => {
    const on = value.includes(k);
    return (
      <button key={k} type="button" data-testid={`tl-emotion-${k}`} aria-pressed={on} onClick={() => toggle(k)}
        className={'inline-flex items-center rounded-full px-3 h-8 md-label-large state-layer border' +
          (on ? ' bg-secondary-container text-on-secondary-container border-transparent font-semibold' : ' text-muted-foreground')}>
        {label}
      </button>
    );
  };
  const group = (title: string, chips: ComponentChildren) => (
    <section key={title} className="flex flex-col gap-1.5">
      <h3 className="text-xs uppercase tracking-wide text-muted-foreground">{title}</h3>
      <div className="flex flex-wrap gap-1.5">{chips}</div>
    </section>
  );
  const yours = sortEmotions(value.filter(k => !VOCABULARY_KEYS.includes(k)));

  return (
    <div className="flex flex-col gap-3" data-testid="tl-emotion-picker">
      {group('General', GENERIC_EMOTIONS.map(e => chip(e, emotionLabel(e))))}
      {EMOTION_GROUPS.map(g => group(g.label, g.emotions.map(e => chip(`${g.key}:${e}`, emotionLabel(e)))))}
      {yours.length > 0 && group('Your own', yours.map(k => chip(k, k)))}
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <MdTextField label="Add your own, e.g. relational:left-out" data-testid="tl-emotion-own" value={own}
            onInput={v => setOwn(v)} onEnter={add} />
        </div>
        <button type="button" data-testid="tl-emotion-add" disabled={!typed} onClick={add}
          className="h-10 px-3 rounded-full text-primary md-label-large state-layer disabled:opacity-40">Add</button>
      </div>
      {own.trim() && !typed && (
        <p className="text-sm text-error" data-testid="tl-emotion-invalid">Up to three parts separated by ":", e.g. temporal:nostalgic:for-college</p>
      )}
    </div>
  );
}
