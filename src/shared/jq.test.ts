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

  // ---- Arithmetic ----
  describe('arithmetic', () => {
    it('addition', () => expect(run('.a + .b', { a: 3, b: 4 })).toEqual([7]));
    it('subtraction', () => expect(run('.a - .b', { a: 10, b: 3 })).toEqual([7]));
    it('multiplication', () => expect(run('. * 2', 5)).toEqual([10]));
    it('division', () => expect(run('. / 2', 10)).toEqual([5]));
    it('modulo', () => expect(run('. % 3', 10)).toEqual([1]));
    it('string concat', () => expect(run('.a + .b', { a: 'hello', b: ' world' })).toEqual(['hello world']));
    it('array concat', () => expect(run('.a + .b', { a: [1], b: [2] })).toEqual([[1, 2]]));
    it('object merge', () => expect(run('.a + .b', { a: { x: 1 }, b: { y: 2 } })).toEqual([{ x: 1, y: 2 }]));
    it('null + value', () => expect(run('null + 1', null)).toEqual([1]));
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
    it('not', () => expect(run('true | not', null)).toEqual([false]));
    it('null is falsy', () => expect(run('null | not', null)).toEqual([true]));
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

  describe('keys and values', () => {
    it('keys of object (sorted)', () => expect(run('keys', { b: 2, a: 1 })).toEqual([['a', 'b']]));
    it('keys of array', () => expect(run('keys', ['x', 'y'])).toEqual([[0, 1]]));
    it('values', () => {
      const result = run('values', { a: 1, b: 2 });
      expect(result[0]).toContain(1);
      expect(result[0]).toContain(2);
    });
  });

  describe('has', () => {
    it('object has key', () => expect(run('has("a")', { a: 1 })).toEqual([true]));
    it('object missing key', () => expect(run('has("b")', { a: 1 })).toEqual([false]));
    it('array has index', () => expect(run('has(1)', [10, 20])).toEqual([true]));
    it('array out of bounds', () => expect(run('has(5)', [10, 20])).toEqual([false]));
  });

  describe('type', () => {
    it('null', () => expect(run('type', null)).toEqual(['null']));
    it('number', () => expect(run('type', 42)).toEqual(['number']));
    it('string', () => expect(run('type', 'hi')).toEqual(['string']));
    it('boolean', () => expect(run('type', true)).toEqual(['boolean']));
    it('array', () => expect(run('type', [])).toEqual(['array']));
    it('object', () => expect(run('type', {})).toEqual(['object']));
  });

  describe('map', () => {
    it('map over array', () => expect(run('map(. * 2)', [1, 2, 3])).toEqual([[2, 4, 6]]));
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

  describe('flatten', () => {
    it('one level', () => expect(run('flatten', [[1, 2], [3, [4]]])).toEqual([[1, 2, 3, [4]]]));
    it('with depth', () => expect(run('flatten(3)', [[1, [2, [3]]]])).toEqual([[1, 2, 3]]));
  });

  describe('add', () => {
    it('sum numbers', () => expect(run('add', [1, 2, 3])).toEqual([6]));
    it('concat strings', () => expect(run('add', ['a', 'b', 'c'])).toEqual(['abc']));
    it('concat arrays', () => expect(run('add', [[1], [2], [3]])).toEqual([[1, 2, 3]]));
    it('empty', () => expect(run('add', [])).toEqual([null]));
  });

  describe('unique', () => {
    it('deduplicates', () => expect(run('unique', [3, 1, 2, 1, 3])).toEqual([[3, 1, 2]]));
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

  describe('group_by', () => {
    it('groups by key', () => {
      const input = [
        { name: 'Alice', dept: 'eng' },
        { name: 'Bob', dept: 'sales' },
        { name: 'Charlie', dept: 'eng' },
      ];
      const result = run('group_by(.dept)', input);
      expect(result[0]).toHaveLength(2);
    });
  });

  describe('min / max / min_by / max_by', () => {
    it('min', () => expect(run('min', [3, 1, 2])).toEqual([1]));
    it('max', () => expect(run('max', [3, 1, 2])).toEqual([3]));
    it('min_by', () => expect(run('min_by(.a)', [{ a: 3 }, { a: 1 }])).toEqual([{ a: 1 }]));
    it('max_by', () => expect(run('max_by(.a)', [{ a: 3 }, { a: 1 }])).toEqual([{ a: 3 }]));
  });

  describe('first / last', () => {
    it('first', () => expect(run('first', [1, 2, 3])).toEqual([1]));
    it('last', () => expect(run('last', [1, 2, 3])).toEqual([3]));
    it('first(expr)', () => expect(run('first(.[])', [10, 20])).toEqual([10]));
  });

  describe('range', () => {
    it('range(n)', () => expect(run('[range(4)]', null)).toEqual([[0, 1, 2, 3]]));
    it('range(a;b)', () => expect(run('[range(2;5)]', null)).toEqual([[2, 3, 4]]));
    it('range(a;b;step)', () => expect(run('[range(0;10;3)]', null)).toEqual([[0, 3, 6, 9]]));
  });

  describe('string functions', () => {
    it('ascii_downcase', () => expect(run('ascii_downcase', 'HELLO')).toEqual(['hello']));
    it('ascii_upcase', () => expect(run('ascii_upcase', 'hello')).toEqual(['HELLO']));
    it('ltrimstr', () => expect(run('ltrimstr("he")', 'hello')).toEqual(['llo']));
    it('rtrimstr', () => expect(run('rtrimstr("lo")', 'hello')).toEqual(['hel']));
    it('startswith', () => expect(run('startswith("hel")', 'hello')).toEqual([true]));
    it('endswith', () => expect(run('endswith("llo")', 'hello')).toEqual([true]));
    it('split', () => expect(run('split(",")', 'a,b,c')).toEqual([['a', 'b', 'c']]));
    it('join', () => expect(run('join("-")', ['a', 'b', 'c'])).toEqual(['a-b-c']));
    it('test', () => expect(run('test("^[0-9]+$")', '123')).toEqual([true]));
    it('test negative', () => expect(run('test("^[0-9]+$")', 'abc')).toEqual([false]));
  });

  describe('contains / inside', () => {
    it('string contains', () => expect(run('contains("ell")', 'hello')).toEqual([true]));
    it('array contains', () => expect(run('contains([2])', [1, 2, 3])).toEqual([true]));
    it('object contains', () => expect(run('contains({"a": 1})', { a: 1, b: 2 })).toEqual([true]));
    it('inside', () => expect(run('inside("hello world")', 'hello')).toEqual([true]));
  });

  // ---- Object/array construction ----
  describe('construction', () => {
    it('object construction', () => expect(run('{name: .n, age: .a}', { n: 'Alice', a: 30 })).toEqual([{ name: 'Alice', age: 30 }]));
    it('object shorthand', () => expect(run('{name, age}', { name: 'Alice', age: 30, extra: 1 })).toEqual([{ name: 'Alice', age: 30 }]));
    it('array construction', () => expect(run('[.[] | . * 2]', [1, 2, 3])).toEqual([[2, 4, 6]]));
    it('empty array literal', () => expect(run('[]', null)).toEqual([[]]));
  });

  // ---- try-catch ----
  describe('try-catch', () => {
    it('try suppresses errors', () => expect(run('try .a.b.c', null)).toEqual([null]));
    it('try-catch', () => expect(run('try error("boom") catch .', null)).toEqual(['boom']));
  });

  // ---- Variables ----
  describe('variables', () => {
    it('as binding', () => expect(run('. as $x | $x + $x', 5)).toEqual([10]));
    it('nested bindings', () => expect(run('.a as $a | .b as $b | $a + $b', { a: 10, b: 20 })).toEqual([30]));
  });

  // ---- reduce ----
  describe('reduce', () => {
    it('sum', () => expect(run('reduce .[] as $x (0; . + $x)', [1, 2, 3])).toEqual([6]));
    it('collect', () => expect(run('reduce .[] as $x ([]; . + [$x * 2])', [1, 2, 3])).toEqual([[2, 4, 6]]));
  });

  // ---- def ----
  describe('def', () => {
    it('simple function', () => expect(run('def double: . * 2; [.[] | double]', [1, 2, 3])).toEqual([[2, 4, 6]]));
    it('function with args', () => expect(run('def addN(n): . + n; 5 | addN(3)', null)).toEqual([8]));
  });

  // ---- Recurse ----
  describe('recurse and ..', () => {
    it('.. finds all values', () => {
      const result = run('.. | numbers', { a: 1, b: { c: 2 }, d: [3] });
      expect(result.sort()).toEqual([1, 2, 3]);
    });
  });

  // ---- Paths ----
  describe('paths', () => {
    it('paths lists all', () => {
      const result = run('[paths]', { a: 1, b: [2] });
      expect(result[0]).toContainEqual(['a']);
      expect(result[0]).toContainEqual(['b']);
      expect(result[0]).toContainEqual(['b', 0]);
    });
    it('getpath', () => expect(run('getpath(["a","b"])', { a: { b: 42 } })).toEqual([42]));
    it('setpath', () => expect(run('setpath(["a"]; 99)', { a: 1, b: 2 })).toEqual([{ a: 99, b: 2 }]));
  });

  // ---- Format strings ----
  describe('format strings', () => {
    it('@json', () => expect(run('@json', { a: 1 })).toEqual(['{"a":1}']));
    it('@html', () => expect(run('@html', '<b>hi</b>')).toEqual(['&lt;b&gt;hi&lt;/b&gt;']));
    it('@csv', () => expect(run('@csv', ['a', 'b', 'c'])).toEqual(['"a","b","c"']));
    it('@uri', () => expect(run('@uri', 'hello world')).toEqual(['hello%20world']));
  });

  // ---- Math ----
  describe('math builtins', () => {
    it('floor', () => expect(run('floor', 3.7)).toEqual([3]));
    it('ceil', () => expect(run('ceil', 3.2)).toEqual([4]));
    it('round', () => expect(run('round', 3.5)).toEqual([4]));
    it('sqrt', () => expect(run('sqrt', 9)).toEqual([3]));
  });

  // ---- tostring / tonumber ----
  describe('conversions', () => {
    it('tostring', () => expect(run('tostring', 42)).toEqual(['42']));
    it('tonumber', () => expect(run('tonumber', '42')).toEqual([42]));
    it('tojson', () => expect(run('tojson', [1, 2])).toEqual(['[1,2]']));
    it('fromjson', () => expect(run('fromjson', '{"a":1}')).toEqual([{ a: 1 }]));
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
      expect(run('[.events[] | select(.start | startswith("2025-06-15")) | .title]', calendar))
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

    it('group tasks by status', () => {
      const result = run('.tasks | to_entries | map(.value) | group_by(.status) | length', taskList);
      expect(result).toEqual([3]); // done, in-progress, todo
    });

    it('high priority tasks', () => {
      expect(run('[.tasks[] | select(.priority <= 1) | .title] | sort', taskList))
        .toEqual([['Fix bug', 'Write tests']]);
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

  // ---- with_entries ----
  describe('with_entries', () => {
    it('transforms object entries', () => {
      expect(run('with_entries(select(.value > 1))', { a: 1, b: 2, c: 3 })).toEqual([{ b: 2, c: 3 }]);
    });
  });

  // ---- limit ----
  describe('limit', () => {
    it('takes first n', () => expect(run('[limit(2; .[])]', [1, 2, 3, 4])).toEqual([[1, 2]]));
  });

  // ---- any / all ----
  describe('any / all', () => {
    it('any with filter', () => expect(run('any(. > 3)', [1, 2, 4])).toEqual([true]));
    it('all with filter', () => expect(run('all(. > 0)', [1, 2, 3])).toEqual([true]));
    it('all false', () => expect(run('all(. > 5)', [1, 2, 3])).toEqual([false]));
  });

  // ---- reverse ----
  describe('reverse', () => {
    it('array', () => expect(run('reverse', [1, 2, 3])).toEqual([[3, 2, 1]]));
    it('string', () => expect(run('reverse', 'abc')).toEqual(['cba']));
  });

  // ---- Array subtraction ----
  describe('array subtraction', () => {
    it('removes matching elements', () => expect(run('. - [2, 3]', [1, 2, 3, 4])).toEqual([[1, 4]]));
  });

  // ---- unique_by ----
  describe('unique_by', () => {
    it('deduplicates by key', () => {
      expect(run('unique_by(.a)', [{ a: 1, b: 'x' }, { a: 2, b: 'y' }, { a: 1, b: 'z' }]))
        .toEqual([[{ a: 1, b: 'x' }, { a: 2, b: 'y' }]]);
    });
  });

  // ---- explode / implode ----
  describe('explode / implode', () => {
    it('explode', () => expect(run('explode', 'AB')).toEqual([[65, 66]]));
    it('implode', () => expect(run('implode', [65, 66])).toEqual(['AB']));
  });

  // ---- indices ----
  describe('indices', () => {
    it('string indices', () => expect(run('indices("o")', 'foobar')).toEqual([[1, 2]]));
    it('array index', () => expect(run('index(2)', [1, 2, 3, 2])).toEqual([1]));
    it('array rindex', () => expect(run('rindex(2)', [1, 2, 3, 2])).toEqual([3]));
  });

  // ---- gsub / sub ----
  describe('sub / gsub', () => {
    it('sub replaces first', () => expect(run('sub("o"; "0")', 'foobar')).toEqual(['f0obar']));
    it('gsub replaces all', () => expect(run('gsub("o"; "0")', 'foobar')).toEqual(['f00bar']));
  });

  // ---- map_values ----
  describe('map_values', () => {
    it('transforms object values', () => expect(run('map_values(. + 1)', { a: 1, b: 2 })).toEqual([{ a: 2, b: 3 }]));
  });

  // ---- Object construction with computed keys ----
  describe('computed object keys', () => {
    it('dynamic keys', () => {
      expect(run('{(.key): .value}', { key: 'name', value: 'Alice' })).toEqual([{ name: 'Alice' }]);
    });
  });

  // ---- until ----
  describe('until', () => {
    it('loops until condition', () => {
      expect(run('until(. >= 10; . * 2)', 1)).toEqual([16]);
    });
  });

  // ---- foreach ----
  describe('foreach', () => {
    it('running sum', () => {
      expect(run('[foreach .[] as $x (0; . + $x)]', [1, 2, 3])).toEqual([[1, 3, 6]]);
    });
  });

  // ---- label-break ----
  describe('label-break', () => {
    it('breaks out of expression', () => {
      expect(run('label $out | foreach .[] as $x (0; . + $x; if . > 3 then ., break $out else . end)', [1, 2, 3, 4])).toEqual([1, 3, 6]);
    });
  });

  // ---- Type-selection builtins ----
  describe('type selectors', () => {
    it('numbers', () => {
      const result = run('[.[] | numbers]', [1, 'a', null, 2, true]);
      expect(result).toEqual([[1, 2]]);
    });
    it('strings', () => {
      const result = run('[.[] | strings]', [1, 'a', null, 'b']);
      expect(result).toEqual([['a', 'b']]);
    });
  });

  // ---- Division produces split for strings ----
  describe('string division', () => {
    it('"a,b,c" / ","', () => expect(run('. / ","', 'a,b,c')).toEqual([['a', 'b', 'c']]));
  });

  // ---- Complex Automerge query ----
  describe('complex document queries', () => {
    const grid = {
      '@type': 'DataGrid',
      name: 'Inventory',
      columns: {
        'col-1': { name: 'Product', type: 'text' },
        'col-2': { name: 'Price', type: 'number' },
        'col-3': { name: 'Stock', type: 'number' },
      },
      rows: {
        'r-1': { 'col-1': 'Widget', 'col-2': 9.99, 'col-3': 100 },
        'r-2': { 'col-1': 'Gadget', 'col-2': 19.99, 'col-3': 50 },
        'r-3': { 'col-1': 'Doohickey', 'col-2': 4.99, 'col-3': 200 },
      },
    };

    it('total inventory value', () => {
      const result = run('[.rows[] | .["col-2"] * .["col-3"]] | add', grid);
      expect(result[0]).toBeCloseTo(9.99 * 100 + 19.99 * 50 + 4.99 * 200);
    });

    it('find cheap products', () => {
      expect(run('[.rows[] | select(.["col-2"] < 10) | .["col-1"]] | sort', grid))
        .toEqual([['Doohickey', 'Widget']]);
    });

    it('column names', () => {
      expect(run('[.columns[] | .name] | sort', grid))
        .toEqual([['Price', 'Product', 'Stock']]);
    });
  });

  // ---- Untrusted-input hardening (hostile queries must not hang the worker) ----
  describe('hostile query hardening', () => {
    it('until(false; .) throws a bounded error instead of hanging', () => {
      expect(() => run('until(false; . + 1)', 0)).toThrow(JqError);
      expect(() => run('until(false; . + 1)', 0)).toThrow(/iterations/);
    });

    it('while(true; .) throws a bounded error when fully consumed', () => {
      expect(() => run('while(true; . + 1)', 0)).toThrow(JqError);
      expect(() => run('while(true; .)', 0)).toThrow(/iterations/);
    });

    it('while under limit() still short-circuits lazily', () => {
      expect(run('[limit(3; while(true; . + 1))]', 0)).toEqual([[0, 1, 2]]);
    });

    it('legitimate until still terminates with the right answer', () => {
      expect(run('until(. >= 1000; . + 1)', 0)).toEqual([1000]);
    });

    it('scan("") terminates with one empty match per position', () => {
      expect(run('[scan("")]', 'ab')).toEqual([['', '', '']]);
    });

    it('scan with a zero-width-capable pattern terminates', () => {
      expect(run('[scan("a*")]', 'abaa')).toEqual([['a', '', 'aa', '']]);
    });

    it('scan zero-width advance keeps surrogate pairs intact', () => {
      expect(run('[scan("")]', '\u{1F600}')).toEqual([['', '']]);
    });

    it('a runaway generator trips the global step budget', () => {
      expect(() => run('[range(1e9)]', null)).toThrow(JqError);
      expect(() => run('[range(1e9)]', null)).toThrow(/step/);
    });

    it('nested loop bombs shielded by try still trip the global budget', () => {
      expect(() => run('until(false; try until(false; . + 1) catch 0)', 0)).toThrow(JqError);
    });

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

  // ---- Dedup/grouping semantics preserved by the hash-based rewrite ----
  describe('unique/group_by equivalence semantics', () => {
    it('unique treats objects with different key order as equal', () => {
      expect(run('unique', [{ a: 1, b: 2 }, { b: 2, a: 1 }])).toEqual([[{ a: 1, b: 2 }]]);
    });

    it('unique keeps first-seen order for nested values', () => {
      expect(run('unique', [[2], [1], [2], [1, 2]])).toEqual([[[2], [1], [1, 2]]]);
    });

    it('unique does not conflate values of different types', () => {
      expect(run('unique', [1, '1', true, null, [1], { '1': 1 }])).toEqual([[1, '1', true, null, [1], { '1': 1 }]]);
    });

    it('unique never merges NaN values (deepEqual semantics)', () => {
      const result = run('unique', [NaN, NaN]);
      expect(result[0]).toHaveLength(2);
    });

    it('group_by sorts groups by key and preserves item order', () => {
      expect(run('group_by(.k)', [{ k: 2, i: 0 }, { k: 1, i: 1 }, { k: 2, i: 2 }]))
        .toEqual([[[{ k: 1, i: 1 }], [{ k: 2, i: 0 }, { k: 2, i: 2 }]]]);
    });

    it('unique_by keeps the first item per key', () => {
      expect(run('unique_by(.a)', [{ a: { x: 1, y: 2 }, b: 1 }, { a: { y: 2, x: 1 }, b: 2 }]))
        .toEqual([[{ a: { x: 1, y: 2 }, b: 1 }]]);
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
});
