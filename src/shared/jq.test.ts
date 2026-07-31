import { run, one, compile, JqError } from './jq';

describe('jq', () => {
  // ---- Identity & literals ----
  describe('identity and literals', () => {
    it('. returns input', () => expect(run('.', 42)).toEqual([42]));
    it('null literal', () => expect(run('null', 1)).toEqual([null]));
    it('true literal', () => expect(run('true', 1)).toEqual([true]));
    it('false literal', () => expect(run('false', 1)).toEqual([false]));
    it('number literal', () => expect(run('42', null)).toEqual([42]));
    it('string literal', () => expect(run('"hello"', null)).toEqual(['hello']));
    it('negative number', () => expect(run('-3', null)).toEqual([-3]));
    it('float literal', () => expect(run('3.14', null)).toEqual([3.14]));
  });

  // ---- Field access ----
  describe('field access', () => {
    const obj = { name: 'Alice', age: 30, nested: { x: 1 } };
    it('.field', () => expect(run('.name', obj)).toEqual(['Alice']));
    it('.field.field', () => expect(run('.nested.x', obj)).toEqual([1]));
    it('missing field is null', () => expect(run('.missing', obj)).toEqual([null]));
    it('.field on null', () => expect(run('.foo', null)).toEqual([null]));
    it('.["key"]', () => expect(run('.["name"]', obj)).toEqual(['Alice']));
  });

  // ---- Array indexing ----
  describe('array indexing', () => {
    const arr = [10, 20, 30, 40, 50];
    it('.[0]', () => expect(run('.[0]', arr)).toEqual([10]));
    it('.[2]', () => expect(run('.[2]', arr)).toEqual([30]));
    it('.[-1]', () => expect(run('.[-1]', arr)).toEqual([50]));
    it('.[-2]', () => expect(run('.[-2]', arr)).toEqual([40]));
    it('out of bounds', () => expect(run('.[10]', arr)).toEqual([null]));
  });

  // ---- Slicing ----
  describe('slicing', () => {
    it('array slice', () => expect(run('.[1:3]', [0, 1, 2, 3, 4])).toEqual([[1, 2]]));
    it('string slice', () => expect(run('.[0:3]', 'hello')).toEqual(['hel']));
    it('open-ended slice', () => expect(run('.[2:]', [0, 1, 2, 3])).toEqual([[2, 3]]));
    it('slice from start', () => expect(run('.[:2]', [0, 1, 2, 3])).toEqual([[0, 1]]));
  });

  // ---- Iteration ----
  describe('iteration', () => {
    it('.[] on array', () => expect(run('.[]', [1, 2, 3])).toEqual([1, 2, 3]));
    it('.[] on object', () => {
      const result = run('.[]', { a: 1, b: 2 });
      expect(result).toContain(1);
      expect(result).toContain(2);
    });
    it('.foo[] chains', () => expect(run('.items[]', { items: [1, 2] })).toEqual([1, 2]));
  });

  // ---- Pipes ----
  describe('pipes', () => {
    it('simple pipe', () => expect(run('.a | .b', { a: { b: 42 } })).toEqual([42]));
    it('multi-pipe', () => expect(run('.a | .b | .c', { a: { b: { c: 1 } } })).toEqual([1]));
  });

  // ---- Comma (multiple outputs) ----
  describe('comma', () => {
    it('.a, .b', () => expect(run('.a, .b', { a: 1, b: 2 })).toEqual([1, 2]));
    it('.a, .b, .c', () => expect(run('.a, .b, .c', { a: 1, b: 2, c: 3 })).toEqual([1, 2, 3]));
  });

  // ---- Comparison ----
  describe('comparison', () => {
    it('==', () => expect(run('. == 1', 1)).toEqual([true]));
    it('!=', () => expect(run('. != 1', 2)).toEqual([true]));
    it('<', () => expect(run('. < 5', 3)).toEqual([true]));
    it('>', () => expect(run('. > 5', 3)).toEqual([false]));
    it('<=', () => expect(run('. <= 5', 5)).toEqual([true]));
    it('>=', () => expect(run('. >= 5', 5)).toEqual([true]));
  });

  // ---- Boolean operators ----
  describe('boolean operators', () => {
    it('and', () => expect(run('true and false', null)).toEqual([false]));
    it('or', () => expect(run('true or false', null)).toEqual([true]));
    it('null is falsy', () => expect(run('null or 1', null)).toEqual([true]));
  });

  // ---- Alternative operator ----
  describe('alternative //', () => {
    it('non-null passes through', () => expect(run('.a // "default"', { a: 'val' })).toEqual(['val']));
    it('null falls through', () => expect(run('.a // "default"', {})).toEqual(['default']));
    it('false falls through', () => expect(run('false // 42', null)).toEqual([42]));
  });

  // ---- if-then-else ----
  describe('if-then-else', () => {
    it('then branch', () => expect(run('if . > 0 then "pos" else "neg" end', 5)).toEqual(['pos']));
    it('else branch', () => expect(run('if . > 0 then "pos" else "neg" end', -1)).toEqual(['neg']));
    it('elif', () => expect(run('if . > 0 then "pos" elif . == 0 then "zero" else "neg" end', 0)).toEqual(['zero']));
    it('without else returns identity', () => expect(run('if . > 0 then "pos" end', -1)).toEqual([-1]));
  });

  // ---- Builtins ----
  describe('length', () => {
    it('string length', () => expect(run('length', 'hello')).toEqual([5]));
    it('array length', () => expect(run('length', [1, 2, 3])).toEqual([3]));
    it('object length', () => expect(run('length', { a: 1, b: 2 })).toEqual([2]));
    it('null length', () => expect(run('length', null)).toEqual([0]));
    it('number abs', () => expect(run('length', -42)).toEqual([42]));
  });

  describe('map', () => {
    it('map over array', () => expect(run('map(. + 1)', [1, 2, 3])).toEqual([[2, 3, 4]]));
    it('map with filter', () => expect(run('map(select(. > 2))', [1, 2, 3, 4])).toEqual([[3, 4]]));
  });

  describe('select', () => {
    it('filters values', () => expect(run('.[] | select(. > 2)', [1, 2, 3, 4])).toEqual([3, 4]));
    it('select with string test', () => {
      expect(run('.[] | select(.age > 25) | .name', [
        { name: 'Alice', age: 30 },
        { name: 'Bob', age: 20 },
      ])).toEqual(['Alice']);
    });
  });

  describe('to_entries / from_entries', () => {
    it('to_entries', () => expect(run('to_entries', { a: 1, b: 2 })).toEqual([
      [{ key: 'a', value: 1 }, { key: 'b', value: 2 }],
    ]));
    it('from_entries', () => expect(run('from_entries', [
      { key: 'a', value: 1 }, { key: 'b', value: 2 },
    ])).toEqual([{ a: 1, b: 2 }]));
    it('roundtrip', () => {
      const obj = { x: 10, y: 20 };
      expect(run('to_entries | from_entries', obj)).toEqual([obj]);
    });
  });

  describe('add', () => {
    it('sum numbers', () => expect(run('add', [1, 2, 3])).toEqual([6]));
    it('concat strings', () => expect(run('add', ['a', 'b', 'c'])).toEqual(['abc']));
    it('concat arrays', () => expect(run('add', [[1], [2], [3]])).toEqual([[1, 2, 3]]));
    it('empty', () => expect(run('add', [])).toEqual([null]));
  });

  describe('sort / sort_by', () => {
    it('sort numbers', () => expect(run('sort', [3, 1, 2])).toEqual([[1, 2, 3]]));
    it('sort_by field', () => expect(run('sort_by(.age)', [
      { name: 'Bob', age: 20 },
      { name: 'Alice', age: 30 },
    ])).toEqual([[
      { name: 'Bob', age: 20 },
      { name: 'Alice', age: 30 },
    ]]));
  });

  // ---- Object/array construction ----
  describe('construction', () => {
    it('object construction', () => expect(run('{name: .n, age: .a}', { n: 'Alice', a: 30 })).toEqual([{ name: 'Alice', age: 30 }]));
    it('object shorthand', () => expect(run('{name, age}', { name: 'Alice', age: 30, extra: 1 })).toEqual([{ name: 'Alice', age: 30 }]));
    it('array construction', () => expect(run('[.[] | . + 10]', [1, 2, 3])).toEqual([[11, 12, 13]]));
    it('empty array literal', () => expect(run('[]', null)).toEqual([[]]));
  });

  // ---- compile/one ----
  describe('compile and one', () => {
    it('compile returns reusable function', () => {
      const fn = compile('.x + .y');
      expect(fn({ x: 1, y: 2 })).toEqual([3]);
      expect(fn({ x: 10, y: 20 })).toEqual([30]);
    });
    it('one returns first result', () => {
      expect(one('.[] | select(. > 2)', [1, 2, 3, 4])).toBe(3);
    });
    it('one returns null for no results', () => {
      expect(one('.[] | select(. > 10)', [1, 2, 3])).toBe(null);
    });
  });

  // ---- Automerge document queries ----
  describe('Automerge document queries', () => {
    const calendar = {
      '@type': 'Calendar',
      name: 'Work',
      events: {
        'evt-1': { '@type': 'Event', title: 'Standup', start: '2025-06-15T09:00:00', duration: 'PT15M', timeZone: 'America/New_York' },
        'evt-2': { '@type': 'Event', title: 'Lunch', start: '2025-06-15T12:00:00', duration: 'PT1H', timeZone: null },
        'evt-3': { '@type': 'Event', title: 'Review', start: '2025-06-16T14:00:00', duration: 'PT30M', timeZone: 'America/New_York' },
      },
    };

    it('list event titles', () => {
      expect(run('[.events[] | .title]', calendar)).toEqual([['Standup', 'Lunch', 'Review']]);
    });

    it('filter events by date prefix', () => {
      expect(run('[.events[] | select(.start[:10] == "2025-06-15") | .title]', calendar))
        .toEqual([['Standup', 'Lunch']]);
    });

    it('count events', () => {
      expect(run('.events | length', calendar)).toEqual([3]);
    });

    it('get event IDs and titles', () => {
      const result = run('.events | to_entries | map({id: .key, title: .value.title})', calendar);
      expect(result[0]).toContainEqual({ id: 'evt-1', title: 'Standup' });
      expect(result[0]).toContainEqual({ id: 'evt-2', title: 'Lunch' });
    });

    it('find events with timezone', () => {
      expect(run('[.events[] | select(.timeZone != null) | .title]', calendar))
        .toEqual([['Standup', 'Review']]);
    });

    const taskList = {
      '@type': 'TaskList',
      name: 'Sprint',
      tasks: {
        't-1': { title: 'Fix bug', status: 'done', priority: 1 },
        't-2': { title: 'Add feature', status: 'in-progress', priority: 2 },
        't-3': { title: 'Write tests', status: 'todo', priority: 1 },
        't-4': { title: 'Deploy', status: 'todo', priority: 3 },
      },
    };

    it('filter tasks by status', () => {
      expect(run('[.tasks[] | select(.status == "todo") | .title] | sort', taskList))
        .toEqual([['Deploy', 'Write tests']]);
    });

    it('high priority tasks', () => {
      expect(run('[.tasks[] | select(.priority <= 1) | .title] | sort', taskList))
        .toEqual([['Fix bug', 'Write tests']]);
    });
  });

  // ---- Untrusted-input hardening ----
  describe('hostile query hardening', () => {
    it('.["__proto__"] yields null, not the prototype object', () => {
      expect(run('.["__proto__"]', { a: 1 })).toEqual([null]);
    });

    it('.__proto__ and .constructor yield null', () => {
      expect(run('.__proto__', { a: 1 })).toEqual([null]);
      expect(run('.constructor', { a: 1 })).toEqual([null]);
    });

    it('an own __proto__ key from JSON is still readable', () => {
      expect(run('.["__proto__"]', JSON.parse('{"__proto__": {"x": 1}}'))).toEqual([{ x: 1 }]);
    });
  });

  // ---- Error handling ----
  describe('errors', () => {
    it('throws on unknown function', () => {
      expect(() => run('notafunction', null)).toThrow(JqError);
    });
    it('throws on bad syntax', () => {
      expect(() => run('.foo |', null)).toThrow(JqError);
    });
  });

  // ---- HOME_SUMMARY_QUERY ----
  describe('HOME_SUMMARY_QUERY', () => {
    const query = '{ type: .["@type"], name: (.name // ""), eventCount: (if .events then (.events | length) else 0 end), taskCount: (if .tasks then (.tasks | length) else 0 end), cellCount: (if .sheets then [.sheets[].cells // {} | length] | add else 0 end) }';

    it('Calendar document', () => {
      const doc = { '@type': 'Calendar', name: 'Work', events: { a: {}, b: {} } };
      expect(one(query, doc)).toEqual({ type: 'Calendar', name: 'Work', eventCount: 2, taskCount: 0, cellCount: 0 });
    });

    it('TaskList document', () => {
      const doc = { '@type': 'TaskList', name: 'Todo', tasks: { t1: {}, t2: {}, t3: {} } };
      expect(one(query, doc)).toEqual({ type: 'TaskList', name: 'Todo', eventCount: 0, taskCount: 3, cellCount: 0 });
    });

    it('DataGrid document', () => {
      const doc = { '@type': 'DataGrid', name: 'Sheet', sheets: {
        s1: { cells: { 'r1:c1': { value: 'a' }, 'r1:c2': { value: 'b' } } },
        s2: { cells: { 'r1:c1': { value: 'x' } } },
      } };
      expect(one(query, doc)).toEqual({ type: 'DataGrid', name: 'Sheet', eventCount: 0, taskCount: 0, cellCount: 3 });
    });

    it('empty document', () => {
      const doc = { '@type': 'Calendar', name: '' };
      expect(one(query, doc)).toEqual({ type: 'Calendar', name: '', eventCount: 0, taskCount: 0, cellCount: 0 });
    });
  });

  // ---- Pinned production queries ----
  describe('production query strings (pinned)', () => {
    // Every jq filter the app ships. jq.ts may only keep syntax these need.
    const doc = {
      '@type': 'TaskList',
      name: 'Sprint',
      description: 'desc',
      color: '#3366ff',
      timeZone: 'UTC',
      events: {
        'evt-1': { '@type': 'Event', title: 'Standup', start: '2026-06-15T09:00:00', recurrenceRule: { until: '2026-07-01T00:00:00' } },
        'evt-2': { '@type': 'Event', title: 'Lunch', start: '2026-05-01T12:00:00' },
      },
      tasks: {
        't-1': { title: 'Fix bug', progress: 'in-progress' },
        't-2': { title: 'Write tests', progress: 'completed' },
        't-3': { title: 'Deploy', progress: 'cancelled' },
      },
      sheets: {
        'sheet-1': {
          name: 'Main', index: 0, hidden: false,
          rows: { 'r-1': { index: 0, height: 22 }, 'r-2': { index: 1, height: 24 }, 'r-3': { index: 2, height: 30 } },
          columns: { 'c-1': { index: 0, name: 'A' }, 'c-2': { index: 1, name: 'B' } },
          cells: { 'r-1:c-1': { value: 'a' }, 'r-2:c-1': { value: 'b' } },
        },
        'sheet-2': { name: 'Second', index: 1, hidden: true, rows: {}, columns: {}, cells: {} },
      },
    };

    it('identity (SourceViewer)', () => {
      expect(run('.', doc)).toEqual([doc]);
    });

    it('type discriminator (DocRoute)', () => {
      expect(one('.["@type"]', doc)).toBe('TaskList');
    });

    it('active sheet (DataGrid sheetQuery)', () => {
      expect(one('.sheets["sheet-1"]', doc)).toEqual(doc.sheets['sheet-1']);
    });

    it('Counters projection', () => {
      expect(one('{ events: (.events // {}), name: (.name // "Counters") }', doc))
        .toEqual({ events: doc.events, name: 'Sprint' });
    });

    it('Tasks projection', () => {
      expect(one('{ tasks: (.tasks // {}), name: (.name // "Tasks") }', doc))
        .toEqual({ tasks: doc.tasks, name: 'Sprint' });
    });

    it('Sentences projection', () => {
      expect(one('{ name: (.name // "Sentences") }', doc)).toEqual({ name: 'Sprint' });
    });

    it('HOME_SUMMARY_QUERY (Home)', () => {
      const query = '{ type: .["@type"], name: (.name // ""), eventCount: (if .events then (.events | length) else 0 end), taskCount: (if .tasks then [.tasks[] | select(.progress != "completed" and .progress != "cancelled")] | length else 0 end), cellCount: (if .sheets then [.sheets[].cells // {} | length] | add else 0 end) }';
      expect(one(query, doc)).toEqual({ type: 'TaskList', name: 'Sprint', eventCount: 2, taskCount: 1, cellCount: 2 });
    });

    it('META_QUERY (DataGrid)', () => {
      const query = '{ "@type": .["@type"], name: (.name // "Spreadsheet"), sheets: (.sheets | to_entries | map({ key: .key, value: { name: .value.name, index: .value.index, hidden: .value.hidden, rows: (.value.rows | to_entries | sort_by(.value.index) | map(.key)), cols: (.value.columns | to_entries | sort_by(.value.index) | map(.key)) } }) | from_entries) }';
      expect(one(query, doc)).toEqual({
        '@type': 'TaskList', name: 'Sprint',
        sheets: {
          'sheet-1': { name: 'Main', index: 0, hidden: false, rows: ['r-1', 'r-2', 'r-3'], cols: ['c-1', 'c-2'] },
          'sheet-2': { name: 'Second', index: 1, hidden: true, rows: [], cols: [] },
        },
      });
    });

    it('calendarQuery (Calendar + AllCalendars)', () => {
      const query = '{ "@type": .["@type"], events: (.events // {} | to_entries | map(select((.value.recurrenceRule != null and .value.start[:10] <= "2026-06-30" and ((.value.recurrenceRule.until // null) == null or .value.recurrenceRule.until[:10] >= "2026-05-01")) or (.value.recurrenceRule == null and .value.start[:10] >= "2026-05-01" and .value.start[:10] <= "2026-06-30"))) | from_entries), name: (.name // "Calendar"), description: (.description // ""), color: .color, timeZone: .timeZone }';
      expect(one(query, doc)).toEqual({
        '@type': 'TaskList',
        events: { 'evt-1': doc.events['evt-1'], 'evt-2': doc.events['evt-2'] },
        name: 'Sprint', description: 'desc', color: '#3366ff', timeZone: 'UTC',
      });
    });

    it('document name (Playwright)', () => {
      expect(one('.name', doc)).toBe('Sprint');
    });

    it('first sheet (Playwright datagrid)', () => {
      expect(one('.sheets | to_entries | map(.value) | .[0]', doc)).toEqual(doc.sheets['sheet-1']);
    });

    it('row height by sorted index (Playwright datagrid)', () => {
      expect(one('.sheets | to_entries | map(.value) | .[0] | .rows | to_entries | sort_by(.value.index) | .[2].value.height', doc)).toBe(30);
    });
  });
});
