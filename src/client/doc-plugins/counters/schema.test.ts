import 'temporal-polyfill/global';
import { validateDocument } from '../../../shared/schemas';
import type { CounterDocument } from './schema';

const validDoc = (): CounterDocument => ({
  '@type': 'Calendar+Counters',
  name: 'Habits',
  events: {
    a: {
      '@type': 'Event',
      title: 'stretch',
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

  it('accepts a recurring counter with no start date', () => {
    const doc = validDoc();
    expect(doc.events.a.start).toBeUndefined();
    expect(validateDocument(doc)).toEqual([]);
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
