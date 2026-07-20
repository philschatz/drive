import { validateDocument } from '../../shared/schemas';
import { validateTask } from './schema';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function hasPath(errors: { path: (string | number)[] }[], expected: (string | number)[]) {
  return errors.some(e =>
    e.path.length === expected.length && e.path.every((v, i) => v === expected[i])
  );
}

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
// Task: extended field validation (Group E)
// ---------------------------------------------------------------------------

describe('Task extended validation', () => {
  function taskListWith(t: any) {
    return { '@type': 'TaskList', name: 'tasks', tasks: { t1: { '@type': 'Task', ...t } } };
  }

  it('flags a non-hex task color', () => {
    const errors = validateDocument(taskListWith({ color: 'red' }));
    expect(hasPath(errors, ['tasks', 't1', 'color'])).toBe(true);
  });

  it('accepts a hex task color', () => {
    const errors = validateDocument(taskListWith({ color: '#00ff00' }));
    expect(errors.some(e => e.path.includes('color'))).toBe(false);
  });

  it('flags a non-hex document color', () => {
    const errors = validateDocument({ '@type': 'TaskList', name: 'tasks', color: 'blue', tasks: {} });
    expect(hasPath(errors, ['color'])).toBe(true);
  });

  it('flags an unparseable start that passes the regex', () => {
    const errors = validateDocument(taskListWith({ start: '2025-13-01' }));
    expect(errors.some(e => e.path.includes('start'))).toBe(true);
  });

  it('flags an unparseable due that passes the regex', () => {
    const errors = validateDocument(taskListWith({ due: '2025-02-30' }));
    expect(errors.some(e => e.path.includes('due') && e.message.includes('valid date/time'))).toBe(true);
  });

  it('flags an invalid estimatedDuration', () => {
    const errors = validateDocument(taskListWith({ estimatedDuration: 'P' }));
    expect(hasPath(errors, ['tasks', 't1', 'estimatedDuration'])).toBe(true);
  });

  it('flags an invalid task timeZone', () => {
    const errors = validateDocument(taskListWith({ timeZone: 'Bogus/Zone' }));
    expect(errors.some(e => e.path.includes('timeZone'))).toBe(true);
  });

  it('flags an invalid document-level timeZone', () => {
    const errors = validateDocument({ '@type': 'TaskList', name: 'tasks', timeZone: 'Bogus/Zone', tasks: {} });
    expect(hasPath(errors, ['timeZone'])).toBe(true);
  });

  it('shares recurrence checks (byMonthDay 0)', () => {
    const errors = validateDocument(taskListWith({ recurrenceRule: { frequency: 'monthly', byMonthDay: [0] } }));
    expect(errors.some(e => e.path.includes('byMonthDay'))).toBe(true);
  });

  it('produces no errors for a well-formed task (no false positives)', () => {
    const errors = validateDocument(taskListWith({
      title: 'Do thing', color: '#4a86e8',
      start: '2025-06-01', due: '2025-06-15', estimatedDuration: 'PT2H', timeZone: 'America/New_York',
      progress: 'in-process', percentComplete: 50, priority: 3,
    }));
    expect(errors).toEqual([]);
  });
});

