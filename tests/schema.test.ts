import { validateDocument, validateCalendarEvent, validateTask } from '../src/shared/schemas';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function hasPath(errors: { path: (string | number)[] }[], expected: (string | number)[]) {
  return errors.some(e =>
    e.path.length === expected.length && e.path.every((v, i) => v === expected[i])
  );
}

// ---------------------------------------------------------------------------
// Calendar document
// ---------------------------------------------------------------------------

describe('Calendar document validation', () => {
  const validCalendar = {
    '@type': 'Calendar',
    name: 'My Calendar',
    events: {},
  };

  it('accepts a minimal valid calendar', () => {
    expect(validateDocument(validCalendar)).toEqual([]);
  });

  it('accepts a calendar with optional fields', () => {
    const doc = { ...validCalendar, description: 'desc', color: '#fff', timeZone: 'America/New_York' };
    expect(validateDocument(doc)).toEqual([]);
  });

  it('rejects missing @type', () => {
    const errors = validateDocument({ name: 'x', events: {} });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects unknown @type', () => {
    const errors = validateDocument({ '@type': 'Foo', name: 'x' });
    expect(errors).toEqual([{ path: ['@type'], message: expect.stringContaining('Unknown') }]);
  });

  it('rejects missing name', () => {
    const errors = validateDocument({ '@type': 'Calendar', events: {} });
    expect(hasPath(errors, ['name'])).toBe(true);
  });

  it('rejects missing events', () => {
    const errors = validateDocument({ '@type': 'Calendar', name: 'x' });
    expect(hasPath(errors, ['events'])).toBe(true);
  });

  it('validates nested events', () => {
    const doc = {
      '@type': 'Calendar',
      name: 'cal',
      events: {
        e1: { '@type': 'Event', title: 'Test', start: '2025-01-15T10:00' },
      },
    };
    expect(validateDocument(doc)).toEqual([]);
  });

  it('reports errors inside events with path', () => {
    const doc = {
      '@type': 'Calendar',
      name: 'cal',
      events: {
        e1: { '@type': 'Event', priority: 99 },
      },
    };
    const errors = validateDocument(doc);
    expect(hasPath(errors, ['events', 'e1', 'priority'])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CalendarEvent
// ---------------------------------------------------------------------------

describe('CalendarEvent validation', () => {
  it('accepts a minimal event', () => {
    expect(validateCalendarEvent({ '@type': 'Event' })).toEqual([]);
  });

  it('rejects wrong @type', () => {
    const errors = validateCalendarEvent({ '@type': 'Task' });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('validates start date format', () => {
    expect(validateCalendarEvent({ '@type': 'Event', start: '2025-01-15' })).toEqual([]);
    expect(validateCalendarEvent({ '@type': 'Event', start: '2025-01-15T10:00' })).toEqual([]);
    const errors = validateCalendarEvent({ '@type': 'Event', start: 'not-a-date' });
    expect(hasPath(errors, ['start'])).toBe(true);
  });

  it('validates duration format', () => {
    expect(validateCalendarEvent({ '@type': 'Event', duration: 'PT1H' })).toEqual([]);
    expect(validateCalendarEvent({ '@type': 'Event', duration: 'P1DT2H30M' })).toEqual([]);
    const errors = validateCalendarEvent({ '@type': 'Event', duration: '1 hour' });
    expect(hasPath(errors, ['duration'])).toBe(true);
  });

  it('validates status enum', () => {
    expect(validateCalendarEvent({ '@type': 'Event', status: 'confirmed' })).toEqual([]);
    const errors = validateCalendarEvent({ '@type': 'Event', status: 'maybe' });
    expect(hasPath(errors, ['status'])).toBe(true);
  });

  it('validates recurrence rule', () => {
    const event = {
      '@type': 'Event',
      recurrenceRule: { frequency: 'weekly', byDay: [{ day: 'mo' }, { day: 'fr' }] },
    };
    expect(validateCalendarEvent(event)).toEqual([]);
  });

  it('rejects invalid recurrence frequency', () => {
    const errors = validateCalendarEvent({
      '@type': 'Event',
      recurrenceRule: { frequency: 'biweekly' },
    });
    expect(hasPath(errors, ['recurrenceRule', 'frequency'])).toBe(true);
  });

  it('validates priority range', () => {
    expect(validateCalendarEvent({ '@type': 'Event', priority: 5 })).toEqual([]);
    const errors = validateCalendarEvent({ '@type': 'Event', priority: 10 });
    expect(hasPath(errors, ['priority'])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Calendar data dependencies
// ---------------------------------------------------------------------------

describe('Calendar data dependencies', () => {
  it('flags mutually exclusive count and until', () => {
    const doc = {
      '@type': 'Calendar',
      name: 'cal',
      events: {
        e1: {
          '@type': 'Event',
          recurrenceRule: { frequency: 'daily', count: 5, until: '2025-12-31' },
        },
      },
    };
    const errors = validateDocument(doc);
    expect(errors.some(e => e.message.includes('mutually exclusive'))).toBe(true);
  });

  it('flags nthOfPeriod with weekly frequency', () => {
    const doc = {
      '@type': 'Calendar',
      name: 'cal',
      events: {
        e1: {
          '@type': 'Event',
          recurrenceRule: { frequency: 'weekly', byDay: [{ day: 'mo', nthOfPeriod: 2 }] },
        },
      },
    };
    const errors = validateDocument(doc);
    expect(errors.some(e => e.message.includes('nthOfPeriod'))).toBe(true);
  });

  it('allows nthOfPeriod with monthly frequency', () => {
    const doc = {
      '@type': 'Calendar',
      name: 'cal',
      events: {
        e1: {
          '@type': 'Event',
          recurrenceRule: { frequency: 'monthly', byDay: [{ day: 'mo', nthOfPeriod: 2 }] },
        },
      },
    };
    const errors = validateDocument(doc);
    expect(errors.filter(e => e.message.includes('nthOfPeriod'))).toEqual([]);
  });

  it('flags dangling participant locationId', () => {
    const doc = {
      '@type': 'Calendar',
      name: 'cal',
      events: {
        e1: {
          '@type': 'Event',
          participants: { p1: { locationId: 'loc1' } },
          replyTo: { imip: 'mailto:a@b.com' },
        },
      },
    };
    const errors = validateDocument(doc);
    expect(errors.some(e => e.message.includes('locationId') && e.message.includes('loc1'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TaskList document
// ---------------------------------------------------------------------------

describe('TaskList document validation', () => {
  const validTaskList = {
    '@type': 'TaskList',
    name: 'My Tasks',
    tasks: {},
  };

  it('accepts a minimal valid task list', () => {
    expect(validateDocument(validTaskList)).toEqual([]);
  });

  it('validates nested tasks', () => {
    const doc = {
      ...validTaskList,
      tasks: {
        t1: { '@type': 'Task', title: 'Do thing', progress: 'needs-action' },
      },
    };
    expect(validateDocument(doc)).toEqual([]);
  });

  it('rejects invalid progress value', () => {
    const doc = {
      ...validTaskList,
      tasks: {
        t1: { '@type': 'Task', progress: 'pending' },
      },
    };
    const errors = validateDocument(doc);
    expect(hasPath(errors, ['tasks', 't1', 'progress'])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

describe('Task validation', () => {
  it('accepts a minimal task', () => {
    expect(validateTask({ '@type': 'Task' })).toEqual([]);
  });

  it('validates due date format', () => {
    expect(validateTask({ '@type': 'Task', due: '2025-06-15' })).toEqual([]);
    const errors = validateTask({ '@type': 'Task', due: 'next friday' });
    expect(hasPath(errors, ['due'])).toBe(true);
  });

  it('validates priority range', () => {
    expect(validateTask({ '@type': 'Task', priority: 0 })).toEqual([]);
    expect(validateTask({ '@type': 'Task', priority: 9 })).toEqual([]);
    const errors = validateTask({ '@type': 'Task', priority: -1 });
    expect(hasPath(errors, ['priority'])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Task data dependencies
// ---------------------------------------------------------------------------

describe('Task data dependencies', () => {
  it('flags due before start', () => {
    const doc = {
      '@type': 'TaskList',
      name: 'tasks',
      tasks: {
        t1: { '@type': 'Task', start: '2025-06-15', due: '2025-06-10' },
      },
    };
    const errors = validateDocument(doc);
    expect(errors.some(e => e.message.includes('due') && e.message.includes('before'))).toBe(true);
  });

  it('allows due after start', () => {
    const doc = {
      '@type': 'TaskList',
      name: 'tasks',
      tasks: {
        t1: { '@type': 'Task', start: '2025-06-01', due: '2025-06-15' },
      },
    };
    const depErrors = validateDocument(doc).filter(e => e.message.includes('before'));
    expect(depErrors).toEqual([]);
  });

  it('flags percentComplete mismatch with completed', () => {
    const doc = {
      '@type': 'TaskList',
      name: 'tasks',
      tasks: {
        t1: { '@type': 'Task', progress: 'completed', percentComplete: 50 },
      },
    };
    const errors = validateDocument(doc);
    expect(hasPath(errors, ['tasks', 't1', 'percentComplete'])).toBe(true);
  });

  it('flags percentComplete mismatch with needs-action', () => {
    const doc = {
      '@type': 'TaskList',
      name: 'tasks',
      tasks: {
        t1: { '@type': 'Task', progress: 'needs-action', percentComplete: 30 },
      },
    };
    const errors = validateDocument(doc);
    expect(hasPath(errors, ['tasks', 't1', 'percentComplete'])).toBe(true);
  });

  it('accepts percentComplete 100 with completed', () => {
    const doc = {
      '@type': 'TaskList',
      name: 'tasks',
      tasks: {
        t1: { '@type': 'Task', progress: 'completed', percentComplete: 100 },
      },
    };
    const depErrors = validateDocument(doc).filter(e =>
      e.path.includes('percentComplete')
    );
    expect(depErrors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// DataGrid document
// ---------------------------------------------------------------------------

/** Wrap sheet data in the multi-sheet DataGrid format. */
function grid(sheetData: { columns: any; rows: any; cells: any }, name = 'Sheet1') {
  return {
    '@type': 'DataGrid',
    name,
    sheets: { s1: { '@type': 'Sheet', name: 'Sheet 1', index: 1, ...sheetData } },
  };
}

describe('DataGrid document validation', () => {
  const validGrid = grid({
    columns: { c1: { index: 1 }, c2: { index: 2 } },
    rows: { r1: { index: 1 }, r2: { index: 2 } },
    cells: {},
  });

  it('accepts a minimal valid datagrid', () => {
    expect(validateDocument(validGrid)).toEqual([]);
  });

  it('accepts a datagrid with cells', () => {
    const doc = grid({
      columns: { c1: { index: 1 }, c2: { index: 2 } },
      rows: { r1: { index: 1 }, r2: { index: 2 } },
      cells: {
        'r1:c1': { value: 'Hello' },
        'r2:c2': { value: '=A1+1' },
      },
    });
    expect(validateDocument(doc)).toEqual([]);
  });

  it('rejects missing columns', () => {
    const doc = grid({ columns: undefined, rows: {}, cells: {} });
    expect(hasPath(validateDocument(doc), ['sheets', 's1', 'columns'])).toBe(true);
  });

  it('accepts non-integer column index', () => {
    const doc = grid({
      columns: { c1: { index: 1.5 } },
      rows: {},
      cells: {},
    });
    expect(hasPath(validateDocument(doc), ['sheets', 's1', 'columns', 'c1', 'index'])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DataGrid data dependencies
// ---------------------------------------------------------------------------

describe('DataGrid data dependencies', () => {
  it('flags duplicate column indices', () => {
    const doc = grid({
      columns: { c1: { index: 1 }, c2: { index: 1 } },
      rows: { r1: { index: 1 } },
      cells: {},
    });
    const errors = validateDocument(doc);
    expect(errors.some(e => e.message.includes('Duplicate column index'))).toBe(true);
  });

  it('flags duplicate row indices', () => {
    const doc = grid({
      columns: { c1: { index: 1 } },
      rows: { r1: { index: 1 }, r2: { index: 1 } },
      cells: {},
    });
    const errors = validateDocument(doc);
    expect(errors.some(e => e.message.includes('Duplicate row index'))).toBe(true);
  });

  it('flags cell key with bad format', () => {
    const doc = grid({
      columns: { c1: { index: 1 } },
      rows: { r1: { index: 1 } },
      cells: { 'badkey': { value: 'x' } },
    });
    const errors = validateDocument(doc);
    expect(errors.some(e => e.message.includes('not in rowId:colId format'))).toBe(true);
  });

  it('flags cell referencing non-existent row', () => {
    const doc = grid({
      columns: { c1: { index: 1 } },
      rows: { r1: { index: 1 } },
      cells: { 'r99:c1': { value: 'x' } },
    });
    const errors = validateDocument(doc);
    expect(errors.some(e => e.message.includes('non-existent row'))).toBe(true);
  });

  it('flags cell referencing non-existent column', () => {
    const doc = grid({
      columns: { c1: { index: 1 } },
      rows: { r1: { index: 1 } },
      cells: { 'r1:c99': { value: 'x' } },
    });
    const errors = validateDocument(doc);
    expect(errors.some(e => e.message.includes('non-existent column'))).toBe(true);
  });

  it('accepts valid cell references', () => {
    const doc = grid({
      columns: { c1: { index: 1 }, c2: { index: 2 } },
      rows: { r1: { index: 1 } },
      cells: { 'r1:c1': { value: 'a' }, 'r1:c2': { value: 'b' } },
    });
    const errors = validateDocument(doc);
    expect(errors).toEqual([]);
  });

  it('flags formula referencing non-existent row UUID', () => {
    const doc = grid({
      columns: { c1: { index: 1 } },
      rows: { r1: { index: 1 } },
      cells: { 'r1:c1': { value: '={R{gone}C{c1}}' } },
    });
    const errors = validateDocument(doc);
    expect(errors.some(e => e.message.includes('Formula references non-existent row "gone"'))).toBe(true);
  });

  it('flags formula referencing non-existent column UUID', () => {
    const doc = grid({
      columns: { c1: { index: 1 } },
      rows: { r1: { index: 1 } },
      cells: { 'r1:c1': { value: '={R{r1}C{gone}}' } },
    });
    const errors = validateDocument(doc);
    expect(errors.some(e => e.message.includes('Formula references non-existent column "gone"'))).toBe(true);
  });

  it('accepts formulas with valid absolute references', () => {
    const doc = grid({
      columns: { c1: { index: 1 }, c2: { index: 2 } },
      rows: { r1: { index: 1 }, r2: { index: 2 } },
      cells: { 'r2:c2': { value: '={R{r1}C{c1}}' } },
    });
    const errors = validateDocument(doc);
    expect(errors).toEqual([]);
  });

  it('accepts formulas with relative references', () => {
    const doc = grid({
      columns: { c1: { index: 1 }, c2: { index: 2 } },
      rows: { r1: { index: 1 }, r2: { index: 2 } },
      cells: { 'r2:c2': { value: '={R[r1]C[c1]}' } },
    });
    const errors = validateDocument(doc);
    expect(errors).toEqual([]);
  });

  it('accepts formulas with mixed references', () => {
    const doc = grid({
      columns: { c1: { index: 1 }, c2: { index: 2 } },
      rows: { r1: { index: 1 }, r2: { index: 2 } },
      cells: { 'r2:c2': { value: '={R{r1}C[c1]}+{R[r2]C{c1}}' } },
    });
    const errors = validateDocument(doc);
    expect(errors).toEqual([]);
  });

  it('flags multiple bad references in a single formula', () => {
    const doc = grid({
      columns: { c1: { index: 1 } },
      rows: { r1: { index: 1 } },
      cells: { 'r1:c1': { value: '={R{badrow}C{badcol}}+{R{alsobad}C{c1}}' } },
    });
    const errors = validateDocument(doc);
    expect(errors.filter(e => e.message.includes('Formula references non-existent')).length).toBe(3);
  });

  it('ignores non-formula cell values', () => {
    const doc = grid({
      columns: { c1: { index: 1 } },
      rows: { r1: { index: 1 } },
      cells: { 'r1:c1': { value: 'just text with {R{fake}C{refs}}' } },
    });
    const errors = validateDocument(doc);
    expect(errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('Edge cases', () => {
  it('rejects null document', () => {
    expect(validateDocument(null)).toEqual([{ path: [], message: 'Document is not an object' }]);
  });

  it('rejects non-object document', () => {
    expect(validateDocument('string')).toEqual([{ path: [], message: 'Document is not an object' }]);
  });
});
