import 'temporal-polyfill/global';
import { validateDocument } from '.';
import type { CounterDocument } from './counters';

const validDoc = (): CounterDocument => ({
  '@type': 'Calendar+Counters',
  name: 'Habits',
  events: {
    a: {
      '@type': 'Event',
      created: '2026-07-01T07:30:00Z',
      title: 'stretch',
      description: '10: Ice cream',
      start: '2026-07-21',
      startTime: '08:00:00',
      duration: 'PT30M',
      recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'daily' },
      completions: { '2026-07-20T08:00:00': '', '2026-07-21T08:05:00': 'PT25M' },
    },
    b: { '@type': 'Event', title: 'free tally' },
  },
});

describe('Calendar+Counters schema', () => {
  it('accepts a valid document', () => {
    expect(validateDocument(validDoc())).toEqual([]);
  });

  it('accepts a recurring counter with no start date (there is none until it is first done)', () => {
    const doc = validDoc();
    delete doc.events.a.start;
    doc.events.a.completions = {};
    expect(validateDocument(doc)).toEqual([]);
  });

  it('accepts an armed one-off: a due date plus the window that decides when it is overdue', () => {
    const doc = validDoc();
    // No recurrence, so `start` means "the day this is wanted" and carries the
    // same startTime/duration window a habit does.
    doc.events.b = {
      '@type': 'Event', title: 'buy chocolate',
      start: '2026-07-21', startTime: '18:00:00', duration: 'PT2H',
      completions: { '2026-07-02T18:30:00': '' },
    };
    // In particular the anchor rule must stay recurring-only: a one-off's `start`
    // is deliberately unrelated to its newest completion.
    expect(validateDocument(doc)).toEqual([]);
  });

  describe('a recurring counter\'s start is its most recent completion', () => {
    it('rejects a start that has drifted from the newest completion', () => {
      const doc = validDoc();
      doc.events.a.start = '2026-07-20'; // the newest completion is on the 21st
      expect(validateDocument(doc).some(e => e.message.includes('most recent completion'))).toBe(true);

      delete doc.events.a.start;
      expect(validateDocument(doc).some(e => e.message.includes('most recent completion'))).toBe(true);
    });

    it('takes the window opening into account: an early click counts for the previous day', () => {
      const doc = validDoc();
      // 07:00 is before the 08:00 startTime, so it belongs to the 21st's window.
      doc.events.a.completions = { '2026-07-22T07:00:00': '' };
      expect(validateDocument(doc)).toEqual([]);

      doc.events.a.startTime = undefined;
      expect(validateDocument(doc).some(e => e.message.includes('"2026-07-22"'))).toBe(true);
    });

    it('leaves a counter with no completions, and a free tally, alone', () => {
      const doc = validDoc();
      doc.events.a.completions = {};
      doc.events.a.start = '2026-07-01'; // a creation anchor from before `created`
      expect(validateDocument(doc)).toEqual([]);

      // No recurrence → `start` is the one-shot's own due date, unconstrained.
      doc.events.b = { '@type': 'Event', title: 'pushups', start: '2026-01-01', completions: { '2026-07-21T09:00:00': '' } };
      expect(validateDocument(doc)).toEqual([]);
    });
  });

  it('rejects a malformed created stamp', () => {
    const doc = validDoc();
    doc.events.a.created = 'last tuesday';
    expect(validateDocument(doc).length).toBeGreaterThan(0);
    doc.events.a.created = '2026-13-45T00:00:00Z'; // passes the regex, not Temporal
    expect(validateDocument(doc).some(e => e.message.includes('created'))).toBe(true);
  });

  it('rejects a bad completion key', () => {
    const doc = validDoc();
    doc.events.a.completions!['not-a-date'] = '';
    expect(validateDocument(doc).some(e => e.message.includes('completion key'))).toBe(true);
  });

  it('rejects a bad completion duration value', () => {
    const doc = validDoc();
    doc.events.a.completions!['2026-07-22T08:00:00'] = 'thirty minutes' as any;
    expect(validateDocument(doc).some(e => e.message.includes('completion duration'))).toBe(true);
  });

  it('rejects a malformed startTime', () => {
    const doc = validDoc();
    doc.events.a.startTime = '25:00';
    expect(validateDocument(doc).length).toBeGreaterThan(0);
  });

  it('rejects a malformed duration', () => {
    const doc = validDoc();
    doc.events.a.duration = 'PT1X' as any;
    expect(validateDocument(doc).length).toBeGreaterThan(0);
  });
});
