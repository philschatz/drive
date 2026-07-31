/**
 * A jq-inspired query engine for Automerge documents.
 *
 * Supports the subset of jq syntax the app actually uses (see the pinned
 * production-query test in jq.test.ts):
 *   .                  identity
 *   .foo / .foo.bar    field access
 *   .["key"]           bracket field access
 *   .[0]               array index
 *   .[from:to]         array/string slice
 *   .[]                iterate all values
 *   .foo, .bar         multiple outputs
 *   .foo | .bar        pipe
 *   select(expr)       keep values where expr is truthy
 *   map(expr)          map over array/object values
 *   length             length of string/array/object (or abs of number)
 *   to_entries / from_entries
 *   sort_by(expr)      sort array by expression (sort = sort by value)
 *   add                fold with + (numbers/strings/arrays/objects)
 *   if c then a elif c then b else d end
 *   ==, !=, <, >, <=, >=, and, or
 *   a // b             alternative (a if not null/false, else b)
 *   null, true, false, numbers, strings
 *   (expr)             parenthesized expression
 *   {key: expr, ...}   object construction (also {key} shorthand)
 *   [expr]             array construction (collect results)
 */

// ---------------------------------------------------------------------------
// Token types
// ---------------------------------------------------------------------------

type TokenType =
  | 'dot' | 'lbracket' | 'rbracket' | 'lparen' | 'rparen'
  | 'lbrace' | 'rbrace' | 'pipe' | 'comma' | 'colon' | 'semicolon'
  | 'ident' | 'string' | 'number' | 'op' | 'eof';

interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

const KEYWORDS = new Set([
  'if', 'then', 'elif', 'else', 'end',
  'and', 'or',
  'true', 'false', 'null',
]);

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const len = input.length;

  while (i < len) {
    if (/\s/.test(input[i])) { i++; continue; }

    if (input[i] === '#') {
      while (i < len && input[i] !== '\n') i++;
      continue;
    }

    const start = i;

    // Two-char operators
    if (i + 1 < len) {
      const two = input[i] + input[i + 1];
      if (two === '//') { tokens.push({ type: 'op', value: '//', pos: start }); i += 2; continue; }
      if (two === '==') { tokens.push({ type: 'op', value: '==', pos: start }); i += 2; continue; }
      if (two === '!=') { tokens.push({ type: 'op', value: '!=', pos: start }); i += 2; continue; }
      if (two === '<=') { tokens.push({ type: 'op', value: '<=', pos: start }); i += 2; continue; }
      if (two === '>=') { tokens.push({ type: 'op', value: '>=', pos: start }); i += 2; continue; }
    }

    const ch = input[i];
    if (ch === '.') { tokens.push({ type: 'dot', value: '.', pos: start }); i++; continue; }
    if (ch === '[') { tokens.push({ type: 'lbracket', value: '[', pos: start }); i++; continue; }
    if (ch === ']') { tokens.push({ type: 'rbracket', value: ']', pos: start }); i++; continue; }
    if (ch === '(') { tokens.push({ type: 'lparen', value: '(', pos: start }); i++; continue; }
    if (ch === ')') { tokens.push({ type: 'rparen', value: ')', pos: start }); i++; continue; }
    if (ch === '{') { tokens.push({ type: 'lbrace', value: '{', pos: start }); i++; continue; }
    if (ch === '}') { tokens.push({ type: 'rbrace', value: '}', pos: start }); i++; continue; }
    if (ch === '|') { tokens.push({ type: 'pipe', value: '|', pos: start }); i++; continue; }
    if (ch === ',') { tokens.push({ type: 'comma', value: ',', pos: start }); i++; continue; }
    if (ch === ':') { tokens.push({ type: 'colon', value: ':', pos: start }); i++; continue; }
    if (ch === ';') { tokens.push({ type: 'semicolon', value: ';', pos: start }); i++; continue; }
    if (ch === '<' || ch === '>' || ch === '+') {
      tokens.push({ type: 'op', value: ch, pos: start }); i++; continue;
    }

    // Strings
    if (ch === '"') {
      i++;
      let str = '';
      while (i < len && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < len) {
          i++;
          const esc = input[i];
          if (esc === 'n') str += '\n';
          else if (esc === 't') str += '\t';
          else if (esc === 'r') str += '\r';
          else if (esc === '\\') str += '\\';
          else if (esc === '"') str += '"';
          else if (esc === '/') str += '/';
          else if (esc === 'u') {
            const hex = input.substring(i + 1, i + 5);
            str += String.fromCharCode(parseInt(hex, 16));
            i += 4;
          }
          else str += esc;
        } else {
          str += input[i];
        }
        i++;
      }
      if (i < len) i++; // skip closing quote
      tokens.push({ type: 'string', value: str, pos: start });
      continue;
    }

    // Numbers
    if (/[0-9]/.test(ch) || (ch === '-' && i + 1 < len && /[0-9]/.test(input[i + 1]) &&
        (tokens.length === 0 || ['op', 'lparen', 'lbracket', 'pipe', 'comma', 'colon', 'semicolon'].includes(tokens[tokens.length - 1].type)))) {
      let num = '';
      if (ch === '-') { num = '-'; i++; }
      while (i < len && /[0-9]/.test(input[i])) { num += input[i]; i++; }
      if (i < len && input[i] === '.' && i + 1 < len && /[0-9]/.test(input[i + 1])) {
        num += '.'; i++;
        while (i < len && /[0-9]/.test(input[i])) { num += input[i]; i++; }
      }
      if (i < len && (input[i] === 'e' || input[i] === 'E')) {
        num += input[i]; i++;
        if (i < len && (input[i] === '+' || input[i] === '-')) { num += input[i]; i++; }
        while (i < len && /[0-9]/.test(input[i])) { num += input[i]; i++; }
      }
      tokens.push({ type: 'number', value: num, pos: start });
      continue;
    }

    // Identifiers / keywords
    if (/[a-zA-Z_]/.test(ch)) {
      let id = '';
      while (i < len && /[a-zA-Z0-9_]/.test(input[i])) { id += input[i]; i++; }
      tokens.push({ type: 'ident', value: id, pos: start });
      continue;
    }

    throw new JqError(`Unexpected character '${ch}' at position ${i}`);
  }

  tokens.push({ type: 'eof', value: '', pos: i });
  return tokens;
}

// ---------------------------------------------------------------------------
// AST node types
// ---------------------------------------------------------------------------

type ASTNode =
  | { type: 'identity' }
  | { type: 'literal'; value: any }
  | { type: 'field'; name: string }
  | { type: 'index'; index: ASTNode }
  | { type: 'slice'; from: ASTNode | null; to: ASTNode | null }
  | { type: 'iterate' }
  | { type: 'pipe'; left: ASTNode; right: ASTNode }
  | { type: 'comma'; left: ASTNode; right: ASTNode }
  | { type: 'binop'; op: string; left: ASTNode; right: ASTNode }
  | { type: 'call'; name: string; args: ASTNode[] }
  | { type: 'if'; cond: ASTNode; then: ASTNode; elifs: {cond: ASTNode; then: ASTNode}[]; else_: ASTNode | null }
  | { type: 'construct_object'; entries: { key: ASTNode; value: ASTNode }[] }
  | { type: 'construct_array'; expr: ASTNode };

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token { return this.tokens[this.pos]; }
  private advance(): Token { return this.tokens[this.pos++]; }

  private expect(type: TokenType, value?: string): Token {
    const t = this.peek();
    if (t.type !== type || (value !== undefined && t.value !== value)) {
      throw new JqError(`Expected ${value ?? type} but got '${t.value}' at position ${t.pos}`);
    }
    return this.advance();
  }

  private match(type: TokenType, value?: string): Token | null {
    const t = this.peek();
    if (t.type === type && (value === undefined || t.value === value)) {
      return this.advance();
    }
    return null;
  }

  parse(): ASTNode {
    const node = this.parsePipe();
    if (this.peek().type !== 'eof') {
      throw new JqError(`Unexpected token '${this.peek().value}' at position ${this.peek().pos}`);
    }
    return node;
  }

  private parsePipe(): ASTNode {
    let left = this.parseComma();
    while (this.match('pipe')) {
      const right = this.parseComma();
      left = { type: 'pipe', left, right };
    }
    return left;
  }

  private parseComma(): ASTNode {
    let left = this.parseOr();
    while (this.match('comma')) {
      const right = this.parseOr();
      left = { type: 'comma', left, right };
    }
    return left;
  }

  private parseOr(): ASTNode {
    let left = this.parseAnd();
    while (this.peek().type === 'ident' && this.peek().value === 'or') {
      this.advance();
      const right = this.parseAnd();
      left = { type: 'binop', op: 'or', left, right };
    }
    return left;
  }

  private parseAnd(): ASTNode {
    let left = this.parseComparison();
    while (this.peek().type === 'ident' && this.peek().value === 'and') {
      this.advance();
      const right = this.parseComparison();
      left = { type: 'binop', op: 'and', left, right };
    }
    return left;
  }

  private parseComparison(): ASTNode {
    let left = this.parseAlternative();
    const ops = ['==', '!=', '<', '>', '<=', '>='];
    while (this.peek().type === 'op' && ops.includes(this.peek().value)) {
      const op = this.advance().value;
      const right = this.parseAlternative();
      left = { type: 'binop', op, left, right };
    }
    return left;
  }

  private parseAlternative(): ASTNode {
    let left = this.parseAddSub();
    while (this.peek().type === 'op' && this.peek().value === '//') {
      this.advance();
      const right = this.parseAddSub();
      left = { type: 'binop', op: '//', left, right };
    }
    return left;
  }

  private parseAddSub(): ASTNode {
    let left = this.parsePostfix();
    while (this.peek().type === 'op' && this.peek().value === '+') {
      this.advance();
      const right = this.parsePostfix();
      left = { type: 'binop', op: '+', left, right };
    }
    return left;
  }

  private parsePostfix(): ASTNode {
    let node = this.parseAtom();

    while (true) {
      // .field
      if (this.peek().type === 'dot') {
        this.advance();
        if (this.peek().type === 'ident') {
          node = { type: 'pipe', left: node, right: { type: 'field', name: this.advance().value } };
        } else if (this.peek().type === 'string') {
          node = { type: 'pipe', left: node, right: { type: 'field', name: this.advance().value } };
        } else {
          // Just a dot after an expression — identity pipe
          node = { type: 'pipe', left: node, right: { type: 'identity' } };
        }
        continue;
      }

      // [index], [from:to], []
      if (this.peek().type === 'lbracket') {
        this.advance();

        // []
        if (this.match('rbracket')) {
          node = { type: 'pipe', left: node, right: { type: 'iterate' } };
          continue;
        }

        // [from:to] slice starting with ':'
        if (this.peek().type === 'colon') {
          this.advance();
          const to = this.parsePipe();
          this.expect('rbracket');
          node = { type: 'pipe', left: node, right: { type: 'slice', from: null, to } };
          continue;
        }

        const expr = this.parsePipe();

        // [from:to]
        if (this.match('colon')) {
          const to = this.peek().type === 'rbracket' ? null : this.parsePipe();
          this.expect('rbracket');
          node = { type: 'pipe', left: node, right: { type: 'slice', from: expr, to } };
          continue;
        }

        this.expect('rbracket');
        node = { type: 'pipe', left: node, right: { type: 'index', index: expr } };
        continue;
      }

      break;
    }

    return node;
  }

  private parseAtom(): ASTNode {
    const t = this.peek();

    // dot access
    if (t.type === 'dot') {
      this.advance();
      // .ident
      if (this.peek().type === 'ident' && !KEYWORDS.has(this.peek().value)) {
        return { type: 'field', name: this.advance().value };
      }
      // .["string"] / .[index] / .[:to] / .[]
      if (this.peek().type === 'lbracket') {
        this.advance();
        if (this.peek().type === 'rbracket') {
          this.advance();
          return { type: 'iterate' };
        }
        if (this.peek().type === 'colon') {
          this.advance();
          const to = this.parsePipe();
          this.expect('rbracket');
          return { type: 'slice', from: null, to };
        }
        const expr = this.parsePipe();
        if (this.match('colon')) {
          const to = this.peek().type === 'rbracket' ? null : this.parsePipe();
          this.expect('rbracket');
          return { type: 'slice', from: expr, to };
        }
        this.expect('rbracket');
        return { type: 'index', index: expr };
      }
      // plain .
      return { type: 'identity' };
    }

    // number literal
    if (t.type === 'number') {
      this.advance();
      return { type: 'literal', value: Number(t.value) };
    }

    // string literal
    if (t.type === 'string') {
      this.advance();
      return { type: 'literal', value: t.value };
    }

    // parenthesized expression
    if (t.type === 'lparen') {
      this.advance();
      const expr = this.parsePipe();
      this.expect('rparen');
      return expr;
    }

    // array construction [expr]
    if (t.type === 'lbracket') {
      this.advance();
      if (this.match('rbracket')) {
        return { type: 'literal', value: [] };
      }
      const expr = this.parsePipe();
      this.expect('rbracket');
      return { type: 'construct_array', expr };
    }

    // object construction {key: val, ...}
    if (t.type === 'lbrace') {
      return this.parseObjectConstruction();
    }

    // keywords and builtins
    if (t.type === 'ident') {
      const name = t.value;

      if (name === 'true') { this.advance(); return { type: 'literal', value: true }; }
      if (name === 'false') { this.advance(); return { type: 'literal', value: false }; }
      if (name === 'null') { this.advance(); return { type: 'literal', value: null }; }
      if (name === 'if') { return this.parseIf(); }

      this.advance();
      if (this.peek().type === 'lparen') {
        this.advance();
        const args: ASTNode[] = [];
        if (this.peek().type !== 'rparen') {
          args.push(this.parsePipe());
          while (this.match('semicolon')) {
            args.push(this.parsePipe());
          }
        }
        this.expect('rparen');
        return { type: 'call', name, args };
      }
      return { type: 'call', name, args: [] };
    }

    throw new JqError(`Unexpected token '${t.value}' at position ${t.pos}`);
  }

  private parseObjectConstruction(): ASTNode {
    this.expect('lbrace');
    const entries: { key: ASTNode; value: ASTNode }[] = [];

    if (this.peek().type !== 'rbrace') {
      do {
        if (this.peek().type === 'ident') {
          const name = this.advance().value;
          if (this.match('colon')) {
            entries.push({ key: { type: 'literal', value: name }, value: this.parseOr() });
          } else {
            // shorthand {name} => {"name": .name}
            entries.push({ key: { type: 'literal', value: name }, value: { type: 'field', name } });
          }
        } else if (this.peek().type === 'string') {
          const key: ASTNode = { type: 'literal', value: this.advance().value };
          this.expect('colon');
          entries.push({ key, value: this.parseOr() });
        } else {
          throw new JqError(`Expected object key at position ${this.peek().pos}`);
        }
      } while (this.match('comma'));
    }

    this.expect('rbrace');
    return { type: 'construct_object', entries };
  }

  private parseIf(): ASTNode {
    this.expect('ident', 'if');
    const cond = this.parsePipe();
    this.expect('ident', 'then');
    const then = this.parsePipe();
    const elifs: {cond: ASTNode; then: ASTNode}[] = [];
    while (this.peek().type === 'ident' && this.peek().value === 'elif') {
      this.advance();
      const elifCond = this.parsePipe();
      this.expect('ident', 'then');
      const elifThen = this.parsePipe();
      elifs.push({ cond: elifCond, then: elifThen });
    }
    let else_: ASTNode | null = null;
    if (this.peek().type === 'ident' && this.peek().value === 'else') {
      this.advance();
      else_ = this.parsePipe();
    }
    this.expect('ident', 'end');
    return { type: 'if', cond, then, elifs, else_ };
  }
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class JqError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JqError';
  }
}

// ---------------------------------------------------------------------------
// Hostile-input budget
//
// Queries and documents can come from untrusted peers, and queries run inside
// the shared worker that services every doc/subscription — runaway evaluation
// must degrade to a thrown JqError (surfaced as a per-subscription error
// result) instead of hanging. Ticked on every evaluator activation.
// ---------------------------------------------------------------------------

const EVAL_STEP_LIMIT = 5_000_000;
let evalSteps = 0;

function tickSteps(): void {
  if (++evalSteps > EVAL_STEP_LIMIT) {
    throw new JqError(`Query exceeded the evaluation step limit (${EVAL_STEP_LIMIT})`);
  }
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

type Env = { [key: string]: any };

function* evaluate(node: ASTNode, input: any, env: Env): Generator<any> {
  tickSteps();
  switch (node.type) {
    case 'identity':
      yield input;
      break;

    case 'literal':
      yield node.value;
      break;

    case 'field': {
      if (input === null || input === undefined) {
        yield null;
        break;
      }
      if (typeof input !== 'object') {
        throw new JqError(`Cannot index ${typeOf(input)} with string "${node.name}"`);
      }
      // Own properties only: `.__proto__` / `.constructor` must yield jq's
      // null, not objects inherited from Object.prototype.
      yield Object.hasOwn(input, node.name) ? input[node.name] ?? null : null;
      break;
    }

    case 'index': {
      for (const idx of evaluate(node.index, input, env)) {
        if (input === null || input === undefined) { yield null; break; }
        if (typeof idx === 'number') {
          if (Array.isArray(input)) {
            const i = idx < 0 ? input.length + idx : idx;
            yield input[i] ?? null;
          } else {
            yield null;
          }
        } else if (typeof idx === 'string') {
          if (typeof input === 'object' && input !== null) {
            // Own properties only (see the 'field' case above).
            yield Object.hasOwn(input, idx) ? input[idx] ?? null : null;
          } else {
            yield null;
          }
        } else {
          throw new JqError(`Cannot index with ${typeOf(idx)}`);
        }
      }
      break;
    }

    case 'slice': {
      if (input === null || input === undefined) { yield null; break; }
      let from = 0;
      let to: number | undefined;
      if (node.from) {
        for (const v of evaluate(node.from, input, env)) { from = v; break; }
      }
      if (node.to) {
        for (const v of evaluate(node.to, input, env)) { to = v; break; }
      }
      if (Array.isArray(input) || typeof input === 'string') {
        yield input.slice(from, to);
      } else {
        yield null;
      }
      break;
    }

    case 'iterate': {
      if (input === null || input === undefined) {
        throw new JqError('Cannot iterate over null');
      }
      if (Array.isArray(input)) {
        for (const v of input) yield v;
      } else if (typeof input === 'object') {
        for (const v of Object.values(input)) yield v;
      } else {
        throw new JqError(`Cannot iterate over ${typeOf(input)}`);
      }
      break;
    }

    case 'pipe': {
      for (const intermediate of evaluate(node.left, input, env)) {
        yield* evaluate(node.right, intermediate, env);
      }
      break;
    }

    case 'comma': {
      yield* evaluate(node.left, input, env);
      yield* evaluate(node.right, input, env);
      break;
    }

    case 'binop': {
      for (const l of evaluate(node.left, input, env)) {
        for (const r of evaluate(node.right, input, env)) {
          yield applyBinop(node.op, l, r);
        }
      }
      break;
    }

    case 'if': {
      for (const c of evaluate(node.cond, input, env)) {
        if (isTruthy(c)) {
          yield* evaluate(node.then, input, env);
        } else {
          let handled = false;
          for (const elif of node.elifs) {
            for (const ec of evaluate(elif.cond, input, env)) {
              if (isTruthy(ec)) {
                yield* evaluate(elif.then, input, env);
                handled = true;
                break;
              }
            }
            if (handled) break;
          }
          if (!handled && node.else_) {
            yield* evaluate(node.else_, input, env);
          } else if (!handled) {
            yield input;
          }
        }
      }
      break;
    }

    case 'construct_array': {
      const arr: any[] = [];
      for (const v of evaluate(node.expr, input, env)) {
        arr.push(v);
      }
      yield arr;
      break;
    }

    case 'construct_object': {
      // For each entry, generate all combinations of key/value outputs
      yield* buildObject(node.entries, 0, {}, input, env);
      break;
    }

    case 'call': {
      yield* evaluateBuiltin(node.name, node.args, input, env);
      break;
    }

    default:
      throw new JqError(`Unknown node type: ${(node as any).type}`);
  }
}

function* buildObject(
  entries: { key: ASTNode; value: ASTNode }[],
  idx: number,
  acc: Record<string, any>,
  input: any,
  env: Env
): Generator<any> {
  if (idx >= entries.length) {
    yield { ...acc };
    return;
  }
  const entry = entries[idx];
  for (const k of evaluate(entry.key, input, env)) {
    for (const v of evaluate(entry.value, input, env)) {
      acc[String(k)] = v;
      yield* buildObject(entries, idx + 1, acc, input, env);
    }
  }
}

function isTruthy(v: any): boolean {
  return v !== false && v !== null;
}

function typeOf(v: any): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function applyBinop(op: string, l: any, r: any): any {
  switch (op) {
    case '+':
      if (typeof l === 'number' && typeof r === 'number') return l + r;
      if (typeof l === 'string' && typeof r === 'string') return l + r;
      if (Array.isArray(l) && Array.isArray(r)) return [...l, ...r];
      if (l !== null && r !== null && typeof l === 'object' && typeof r === 'object' && !Array.isArray(l) && !Array.isArray(r)) {
        return { ...l, ...r };
      }
      if (l === null) return r;
      if (r === null) return l;
      throw new JqError(`Cannot add ${typeOf(l)} and ${typeOf(r)}`);
    case '==': return deepEqual(l, r);
    case '!=': return !deepEqual(l, r);
    case '<': return compare(l, r) < 0;
    case '>': return compare(l, r) > 0;
    case '<=': return compare(l, r) <= 0;
    case '>=': return compare(l, r) >= 0;
    case 'and': return isTruthy(l) && isTruthy(r);
    case 'or': return isTruthy(l) || isTruthy(r);
    case '//': return (l !== null && l !== false) ? l : r;
    default:
      throw new JqError(`Unknown operator: ${op}`);
  }
}

function deepEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((v: any, i: number) => deepEqual(v, b[i]));
  }
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  return ka.every((k, i) => k === kb[i] && deepEqual(a[k], b[k]));
}

function compare(a: any, b: any): number {
  const order: Record<string, number> = { 'null': 0, 'boolean': 1, 'number': 2, 'string': 3, 'array': 4, 'object': 5 };
  const ta = typeOf(a);
  const tb = typeOf(b);
  if (ta !== tb) return (order[ta] ?? 6) - (order[tb] ?? 6);
  if (ta === 'null') return 0;
  if (ta === 'boolean') return (a ? 1 : 0) - (b ? 1 : 0);
  if (ta === 'number') return a - b;
  if (ta === 'string') return a < b ? -1 : a > b ? 1 : 0;
  if (ta === 'array') {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const c = compare(a[i], b[i]);
      if (c !== 0) return c;
    }
    return a.length - b.length;
  }
  // object comparison by sorted keys
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  for (let i = 0; i < Math.min(ka.length, kb.length); i++) {
    const kc = ka[i] < kb[i] ? -1 : ka[i] > kb[i] ? 1 : 0;
    if (kc !== 0) return kc;
    const vc = compare(a[ka[i]], b[kb[i]]);
    if (vc !== 0) return vc;
  }
  return ka.length - kb.length;
}

function first(gen: Generator<any>): any {
  const result = gen.next();
  return result.done ? null : result.value;
}

// ---------------------------------------------------------------------------
// Builtins
// ---------------------------------------------------------------------------

function* evaluateBuiltin(name: string, args: ASTNode[], input: any, env: Env): Generator<any> {
  switch (name) {
    case 'length':
      if (input === null) yield 0;
      else if (typeof input === 'string') yield input.length;
      else if (Array.isArray(input)) yield input.length;
      else if (typeof input === 'object') yield Object.keys(input).length;
      else if (typeof input === 'number') yield Math.abs(input);
      else yield 0;
      break;

    case 'map': {
      if (!Array.isArray(input) && (input === null || typeof input !== 'object')) {
        throw new JqError(`Cannot iterate over ${typeOf(input)}`);
      }
      const items = Array.isArray(input) ? input : Object.values(input);
      const result: any[] = [];
      for (const item of items) {
        for (const v of evaluate(args[0], item, env)) {
          result.push(v);
        }
      }
      yield result;
      break;
    }

    case 'select': {
      for (const v of evaluate(args[0], input, env)) {
        if (isTruthy(v)) yield input;
      }
      break;
    }

    case 'to_entries':
      if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
        yield Object.entries(input).map(([key, value]) => ({ key, value }));
      } else {
        throw new JqError(`to_entries requires an object, got ${typeOf(input)}`);
      }
      break;

    case 'from_entries':
      if (Array.isArray(input)) {
        const obj: any = {};
        for (const item of input) {
          const k = item.key ?? item.name ?? item.Key ?? item.Name;
          obj[String(k)] = item.value ?? item.Value ?? null;
        }
        yield obj;
      } else {
        throw new JqError(`from_entries requires an array`);
      }
      break;

    case 'sort':
    case 'sort_by': {
      if (!Array.isArray(input)) { yield input; break; }
      const arr = [...input];
      if (args.length > 0) {
        const keyed = arr.map(item => ({ item, key: first(evaluate(args[0], item, env)) }));
        keyed.sort((a, b) => compare(a.key, b.key));
        yield keyed.map(k => k.item);
      } else {
        arr.sort(compare);
        yield arr;
      }
      break;
    }

    case 'add': {
      if (!Array.isArray(input) || input.length === 0) { yield null; break; }
      let acc = input[0];
      for (let i = 1; i < input.length; i++) {
        acc = applyBinop('+', acc, input[i]);
      }
      yield acc;
      break;
    }

    default:
      throw new JqError(`Unknown function: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compile a jq filter string into a reusable query function.
 */
export function compile(filter: string): (input: any) => any[] {
  const tokens = tokenize(filter);
  const ast = new Parser(tokens).parse();
  return (input: any) => {
    evalSteps = 0; // fresh step budget per query invocation
    const results: any[] = [];
    for (const v of evaluate(ast, input, {})) {
      if (v !== undefined) results.push(v);
    }
    return results;
  };
}

/**
 * Run a jq filter on an input value and return all results.
 */
export function run(filter: string, input: any): any[] {
  return compile(filter)(input);
}

/**
 * Run a jq filter and return the first result, or null.
 */
export function one(filter: string, input: any): any {
  const results = run(filter, input);
  return results.length > 0 ? results[0] : null;
}
