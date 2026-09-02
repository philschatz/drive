import 'temporal-polyfill/global';
import { matchCounters, SUGGESTION_CAP } from './suggestions';
import type { CounterEvent } from '../../../../shared/schemas/counters';

const NOW = '2026-07-21T12:00:00'; // a Tuesday

const checklist = (title: string, extra: Partial<CounterEvent> = {}): CounterEvent => ({
  '@type': 'Event',
  title,
  ...extra,
});

const daily = (title: string, extra: Partial<CounterEvent> = {}): CounterEvent => ({
  '@type': 'Event',
  title,
  recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'daily' },
  ...extra,
});

describe('matchCounters', () => {
  it('returns nothing for an empty or whitespace-only query', () => {
    const events = { e1: checklist('Stretch') };
    expect(matchCounters(events, '', NOW)).toEqual([]);
    expect(matchCounters(events, '   ', NOW)).toEqual([]);
  });

  it('never matches an untitled event', () => {
    const events = { e1: checklist(''), e2: { '@type': 'Event' } as CounterEvent };
    expect(matchCounters(events, 'anything', NOW)).toEqual([]);
  });

  it('matches case-insensitively on a trimmed substring', () => {
    const events = { e1: checklist('Water the Plants') };
    expect(matchCounters(events, 'PLANT', NOW).map(m => m.uid)).toEqual(['e1']);
    expect(matchCounters(events, '  water ', NOW).map(m => m.uid)).toEqual(['e1']);
    expect(matchCounters(events, 'weed', NOW)).toEqual([]);
  });

  it('ranks exact above prefix above substring, then shorter titles first', () => {
    const events = {
      sub: checklist('Deep stretch'),
      prefixLong: checklist('Stretch hamstrings'),
      prefix: checklist('Stretches'),
      exact: checklist('Stretch'),
    };
    expect(matchCounters(events, 'stretch', NOW).map(m => m.uid))
      .toEqual(['exact', 'prefix', 'prefixLong', 'sub']);
  });

  it('flags the exact match, case-insensitively and trimmed', () => {
    const events = { e1: checklist('Stretch'), e2: checklist('Stretches') };
    const matches = matchCounters(events, '  STRETCH ', NOW);
    expect(matches.map(m => [m.uid, m.exact])).toEqual([['e1', true], ['e2', false]]);
  });

  it('caps the list, and an exact match always survives the cap', () => {
    const events: Record<string, CounterEvent> = { exact: checklist('Run') };
    for (let i = 0; i < SUGGESTION_CAP + 2; i++) events['p' + i] = checklist('Run ' + i);
    const matches = matchCounters(events, 'run', NOW);
    expect(matches).toHaveLength(SUGGESTION_CAP);
    expect(matches[0]).toMatchObject({ uid: 'exact', exact: true });
  });

  it('skips excludeUid', () => {
    const events = { e1: checklist('Stretch'), e2: checklist('Stretch more') };
    expect(matchCounters(events, 'stretch', NOW, 'e1').map(m => m.uid)).toEqual(['e2']);
  });

  it('marks an archived habit and gives it no status', () => {
    const events = {
      e1: daily('Stretch', { recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'daily', until: '2026-07-01T00:00:00' } }),
    };
    expect(matchCounters(events, 'stretch', NOW)).toEqual([
      { uid: 'e1', title: 'Stretch', kind: 'recurring', archived: true, status: undefined, dueAt: undefined, exact: true },
    ]);
  });

  it('ranks an active exact match above its archived twin', () => {
    const events = {
      dead: daily('Stretch', { recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'daily', until: '2026-07-01T00:00:00' } }),
      live: checklist('Stretch'),
    };
    const matches = matchCounters(events, 'stretch', NOW);
    expect(matches.map(m => [m.uid, m.exact, m.archived])).toEqual([['live', true, false], ['dead', true, true]]);
  });

  it('reports a done habit with when it comes due again', () => {
    // Completed this morning: anchored there, done until halfway to tomorrow.
    const events = { e1: daily('Stretch', { start: '2026-07-21T09:00:00', completions: { '2026-07-21T09:00:00.000': '' } }) };
    const [m] = matchCounters(events, 'stretch', NOW);
    expect(m.status).toBe('done');
    expect(m.dueAt).toBeTruthy();
    expect(m.dueAt! > NOW).toBe(true);
  });

  it('reports statuses that carry no dueAt for the label', () => {
    const events = {
      parked: checklist('Read'),
      armed: checklist('Read more', { start: '2026-07-21T08:00:00' }),
    };
    const byUid = Object.fromEntries(matchCounters(events, 'read', NOW).map(m => [m.uid, m]));
    expect(byUid.parked).toMatchObject({ status: 'anytime', dueAt: undefined, kind: 'checklist' });
    expect(byUid.armed).toMatchObject({ status: 'due', dueAt: undefined });
  });
});
