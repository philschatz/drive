/**
 * A jq-inspired query engine for Automerge documents.
 *
 * Supports a subset of jq syntax:
 *   .                  identity
 *   .foo               field access
 *   .foo.bar           chained field access
 *   .["key"]           bracket field access (quoted key)
 *   .[0]               array index
 *   .[-1]              negative array index (from end)
 *   .[2:5]             array/string slice
 *   .[]                iterate all values
 *   .foo[]             iterate values of .foo
 *   .foo, .bar         multiple outputs
 *   .foo | .bar        pipe
 *   select(expr)       filter: keep values where expr is truthy
 *   length             length of string/array/object
 *   keys               object keys or array indices
 *   values             object/array values
 *   has("key")         test if object has key
 *   type               type name ("object", "array", "string", "number", "boolean", "null")
 *   not                boolean negation
 *   map(expr)          map over array/object values
 *   to_entries          {k:v,...} -> [{key:k, value:v},...]
 *   from_entries        inverse of to_entries
 *   flatten             flatten nested arrays (one level)
 *   add                reduce with + (numbers, strings, arrays, objects)
 *   any                true if any element is truthy
 *   all                true if all elements are truthy
 *   unique             deduplicate array
 *   sort_by(expr)      sort array by expression
 *   group_by(expr)     group array elements by expression
 *   min_by(expr)       minimum by expression
 *   max_by(expr)       maximum by expression
 *   first              first element
 *   last               last element
 *   limit(n; expr)     take first n results from expr
 *   range(n)           [0..n-1]
 *   range(a;b)         [a..b-1]
 *   ascii_downcase     lowercase string
 *   ascii_upcase       uppercase string
 *   ltrimstr("s")      remove prefix
 *   rtrimstr("s")      remove suffix
 *   split("s")         split string
 *   join("s")          join array with separator
 *   test("regex")      regex test
 *   match("regex")     regex match (returns object with offset, length, string, captures)
 *   capture("regex")   regex named captures as object
 *   contains(v)        deep containment test
 *   inside(v)          inverse of contains
 *   startswith("s")    string prefix test
 *   endswith("s")      string suffix test
 *   null, true, false  literals
 *   42, 3.14, "str"    numeric and string literals
 *   ==, !=, <, >, <=, >=  comparison operators
 *   and, or            boolean operators
 *   +, -, *, /, %      arithmetic operators
 *   // (alternative)   a // b = a if a is not null/false, else b
 *   if-then-else       if cond then a (elif cond then b)* (else c)? end
 *   (expr)             parenthesized expression
 *   {key: expr, ...}   object construction
 *   [expr]             array construction (collect results)
 *   ?//                try-catch (optional operator: suppress errors)
 *   .foo?              optional field access (no error if not object)
 *   not                logical not
 *   empty              produce no output
 *   error("msg")       throw error
 *   debug              pass through, log to console
 *   env                environment object (empty in browser)
 *   input              no-op (single input already provided)
 *   recurse            recursively descend
 *   ..                 shorthand for recurse
 *   paths              all paths as arrays
 *   getpath(p)         get value at path
 *   setpath(p; v)      set value at path (returns new value)
 *   delpaths(ps)       delete paths
 *   leaf_paths         paths to leaf (non-collection) values
 *   path(expr)         output paths that expr would access
 *   with_entries(expr) to_entries | map(expr) | from_entries
 *   indices("s")       all indices of substring/element
 *   IN(expr)           test membership against expr outputs
 *   ascii              character code
 *   explode            string -> array of codepoints
 *   implode            array of codepoints -> string
 *   tojson             serialize to JSON string
 *   fromjson           parse JSON string
 *   @base64            encode as base64
 *   @base64d           decode from base64
 *   @uri               URI-encode
 *   @html              HTML-escape
 *   @csv               format as CSV row
 *   @tsv               format as TSV row
 *   @json              alias for tojson
 *   @text              convert to string
 *   def name(args): body;  function definitions
 *   label-break        label $name | break $name
 *   try-catch          try expr catch expr
 *   as $var | expr     variable binding
 *   $var               variable reference
 *   reduce             reduce .[] as $x (init; update)
 *   foreach            foreach .[] as $x (init; update; extract)
 *   limit(n; expr)     take first n outputs of expr
 *   until(cond; update) loop until condition
 *   while(cond; update) loop while condition
 *   repeat(f)          infinite loop with f
 *   isnan, isinfinite, nan, infinite  numeric tests/values
 *   builtins           list all builtins
 *   gsub(re; s)        global regex substitution
 *   sub(re; s)         first regex substitution
 *   splits(re)         split by regex (stream)
 *   scan(re)           find all regex matches
 *   nth(n; expr)       nth output of expr
 *   transpose          transpose array of arrays
 *   input, inputs      no-op / empty (single-input model)
 *   modulemeta         no-op
 */

// ---------------------------------------------------------------------------
// Token types
// ---------------------------------------------------------------------------

type TokenType =
  | 'dot' | 'lbracket' | 'rbracket' | 'lparen' | 'rparen'
  | 'lbrace' | 'rbrace' | 'pipe' | 'comma' | 'colon' | 'semicolon'
  | 'question' | 'ident' | 'string' | 'number' | 'op'
  | 'dotdot' | 'format' | 'dollar_ident' | 'eof';

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
  'and', 'or', 'not',
  'true', 'false', 'null',
  'try', 'catch',
  'as', 'def', 'reduce', 'foreach', 'label', 'break',
  'import', 'include',
  'empty',
]);

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const len = input.length;

  while (i < len) {
    // Skip whitespace
    if (/\s/.test(input[i])) { i++; continue; }

    // Skip comments
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
      if (two === '..') { tokens.push({ type: 'dotdot', value: '..', pos: start }); i += 2; continue; }
      if (two === '?/') {
        if (i + 2 < len && input[i + 2] === '/') {
          tokens.push({ type: 'op', value: '?//', pos: start }); i += 3; continue;
        }
      }
    }

    // Single-char tokens
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
    if (ch === '?') { tokens.push({ type: 'question', value: '?', pos: start }); i++; continue; }
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '%') {
      tokens.push({ type: 'op', value: ch, pos: start }); i++; continue;
    }
    if (ch === '<' || ch === '>') {
      tokens.push({ type: 'op', value: ch, pos: start }); i++; continue;
    }
    if (ch === '=') {
      tokens.push({ type: 'op', value: '=', pos: start }); i++; continue;
    }

    // Format strings (@base64, @uri, etc.)
    if (ch === '@') {
      i++;
      let name = '';
      while (i < len && /[a-zA-Z0-9_]/.test(input[i])) { name += input[i]; i++; }
      tokens.push({ type: 'format', value: '@' + name, pos: start });
      continue;
    }

    // $variable
    if (ch === '$') {
      i++;
      let name = '$';
      while (i < len && /[a-zA-Z0-9_]/.test(input[i])) { name += input[i]; i++; }
      tokens.push({ type: 'dollar_ident', value: name, pos: start });
      continue;
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
  | { type: 'field'; name: string; optional: boolean }
  | { type: 'index'; index: ASTNode }
  | { type: 'slice'; from: ASTNode | null; to: ASTNode | null }
  | { type: 'iterate'; optional: boolean }
  | { type: 'recurse' }
  | { type: 'pipe'; left: ASTNode; right: ASTNode }
  | { type: 'comma'; left: ASTNode; right: ASTNode }
  | { type: 'binop'; op: string; left: ASTNode; right: ASTNode }
  | { type: 'unary_minus'; expr: ASTNode }
  | { type: 'not' }
  | { type: 'call'; name: string; args: ASTNode[] }
  | { type: 'if'; cond: ASTNode; then: ASTNode; elifs: {cond: ASTNode; then: ASTNode}[]; else_: ASTNode | null }
  | { type: 'try'; body: ASTNode; catch_: ASTNode | null }
  | { type: 'optional'; expr: ASTNode }
  | { type: 'construct_object'; entries: { key: ASTNode; value: ASTNode }[] }
  | { type: 'construct_array'; expr: ASTNode }
  | { type: 'format'; name: string }
  | { type: 'as_pattern'; expr: ASTNode; pattern: Pattern; body: ASTNode }
  | { type: 'reduce'; expr: ASTNode; pattern: Pattern; init: ASTNode; update: ASTNode }
  | { type: 'foreach'; expr: ASTNode; pattern: Pattern; init: ASTNode; update: ASTNode; extract: ASTNode | null }
  | { type: 'label'; name: string; body: ASTNode }
  | { type: 'break_'; name: string }
  | { type: 'def'; name: string; params: string[]; body: ASTNode; rest: ASTNode }
  | { type: 'var_ref'; name: string }
  | { type: 'limit'; n: ASTNode; expr: ASTNode }
  | { type: 'string_interp'; parts: (string | ASTNode)[] };

type Pattern = { type: 'var'; name: string } | { type: 'array'; elements: Pattern[] } | { type: 'object'; entries: { key: string; value: Pattern }[] };

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
    let left = this.parseAs();
    while (this.match('comma')) {
      const right = this.parseAs();
      left = { type: 'comma', left, right };
    }
    return left;
  }

  private parseAs(): ASTNode {
    let expr = this.parseOr();
    if (this.peek().type === 'ident' && this.peek().value === 'as') {
      this.advance();
      const pattern = this.parsePattern();
      this.expect('pipe');
      const body = this.parsePipe();
      return { type: 'as_pattern', expr, pattern, body };
    }
    return expr;
  }

  private parsePattern(): Pattern {
    if (this.peek().type === 'dollar_ident') {
      return { type: 'var', name: this.advance().value };
    }
    if (this.match('lbracket')) {
      const elements: Pattern[] = [];
      if (!this.match('rbracket')) {
        elements.push(this.parsePattern());
        while (this.match('comma')) {
          elements.push(this.parsePattern());
        }
        this.expect('rbracket');
      }
      return { type: 'array', elements };
    }
    if (this.match('lbrace')) {
      const entries: { key: string; value: Pattern }[] = [];
      if (!this.match('rbrace')) {
        do {
          const key = this.expect('ident').value;
          this.expect('colon');
          const value = this.parsePattern();
          entries.push({ key, value });
        } while (this.match('comma'));
        this.expect('rbrace');
      }
      return { type: 'object', entries };
    }
    throw new JqError(`Expected pattern at position ${this.peek().pos}`);
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
    let left = this.parseNot();
    while (this.peek().type === 'ident' && this.peek().value === 'and') {
      this.advance();
      const right = this.parseNot();
      left = { type: 'binop', op: 'and', left, right };
    }
    return left;
  }

  private parseNot(): ASTNode {
    // In jq, `not` is a builtin filter (postfix), not a prefix operator.
    // It's handled as a regular builtin call in parseAtom.
    return this.parseComparison();
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
    let left = this.parseMulDiv();
    while (this.peek().type === 'op' && (this.peek().value === '+' || this.peek().value === '-')) {
      const op = this.advance().value;
      const right = this.parseMulDiv();
      left = { type: 'binop', op, left, right };
    }
    return left;
  }

  private parseMulDiv(): ASTNode {
    let left = this.parseUnary();
    while (this.peek().type === 'op' && (this.peek().value === '*' || this.peek().value === '/' || this.peek().value === '%')) {
      const op = this.advance().value;
      const right = this.parseUnary();
      left = { type: 'binop', op, left, right };
    }
    return left;
  }

  private parseUnary(): ASTNode {
    if (this.peek().type === 'op' && this.peek().value === '-') {
      this.advance();
      return { type: 'unary_minus', expr: this.parsePostfix() };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): ASTNode {
    let node = this.parseAtom();

    while (true) {
      // .field
      if (this.peek().type === 'dot') {
        const dotPos = this.peek().pos;
        this.advance();
        if (this.peek().type === 'ident') {
          const name = this.advance().value;
          const optional = !!this.match('question');
          node = { type: 'pipe', left: node, right: { type: 'field', name, optional } };
        } else if (this.peek().type === 'string') {
          const name = this.advance().value;
          const optional = !!this.match('question');
          node = { type: 'pipe', left: node, right: { type: 'field', name, optional } };
        } else {
          // Just a dot after expression — that's identity pipe
          node = { type: 'pipe', left: node, right: { type: 'identity' } };
        }
        continue;
      }

      // [index], [from:to], []
      if (this.peek().type === 'lbracket') {
        this.advance();
        const optional = false;

        // []
        if (this.match('rbracket')) {
          const optQ = !!this.match('question');
          node = { type: 'pipe', left: node, right: { type: 'iterate', optional: optQ } };
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
        const optQ = !!this.match('question');
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
        const name = this.advance().value;
        const optional = !!this.match('question');
        return { type: 'field', name, optional };
      }
      // .["string"]
      if (this.peek().type === 'lbracket') {
        this.advance();
        if (this.peek().type === 'rbracket') {
          this.advance();
          const optional = !!this.match('question');
          return { type: 'iterate', optional };
        }
        // Check for slice starting with ':'
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
        const optional = !!this.match('question');
        return { type: 'index', index: expr };
      }
      // plain .
      return { type: 'identity' };
    }

    // ..
    if (t.type === 'dotdot') {
      this.advance();
      return { type: 'recurse' };
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

    // format strings
    if (t.type === 'format') {
      this.advance();
      return { type: 'format', name: t.value };
    }

    // $variable
    if (t.type === 'dollar_ident') {
      this.advance();
      return { type: 'var_ref', name: t.value };
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

      // Literals
      if (name === 'true') { this.advance(); return { type: 'literal', value: true }; }
      if (name === 'false') { this.advance(); return { type: 'literal', value: false }; }
      if (name === 'null') { this.advance(); return { type: 'literal', value: null }; }

      // not
      if (name === 'not') { this.advance(); return { type: 'not' }; }

      // empty
      if (name === 'empty') { this.advance(); return { type: 'call', name: 'empty', args: [] }; }

      // if-then-else
      if (name === 'if') { return this.parseIf(); }

      // try-catch
      if (name === 'try') { return this.parseTry(); }

      // def
      if (name === 'def') { return this.parseDef(); }

      // reduce
      if (name === 'reduce') { return this.parseReduce(); }

      // foreach
      if (name === 'foreach') { return this.parseForeach(); }

      // label-break
      if (name === 'label') { return this.parseLabel(); }
      if (name === 'break') {
        this.advance();
        const bname = this.expect('dollar_ident').value;
        return { type: 'break_', name: bname };
      }

      // Function/builtin calls
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
        // Special handling for limit
        if (name === 'limit' && args.length === 2) {
          return { type: 'limit', n: args[0], expr: args[1] };
        }
        return { type: 'call', name, args };
      }
      return { type: 'call', name, args: [] };
    }

    // Negative number at start or after operator
    if (t.type === 'op' && t.value === '-') {
      this.advance();
      const expr = this.parsePostfix();
      return { type: 'unary_minus', expr };
    }

    throw new JqError(`Unexpected token '${t.value}' at position ${t.pos}`);
  }

  private parseObjectConstruction(): ASTNode {
    this.expect('lbrace');
    const entries: { key: ASTNode; value: ASTNode }[] = [];

    if (this.peek().type !== 'rbrace') {
      do {
        let key: ASTNode;
        if (this.peek().type === 'ident') {
          const name = this.advance().value;
          if (this.match('colon')) {
            key = { type: 'literal', value: name };
            const value = this.parseAs();
            entries.push({ key, value });
          } else {
            // shorthand {name} => {"name": .name}
            key = { type: 'literal', value: name };
            entries.push({ key, value: { type: 'field', name, optional: false } });
          }
        } else if (this.peek().type === 'string') {
          key = { type: 'literal', value: this.advance().value };
          this.expect('colon');
          const value = this.parseAs();
          entries.push({ key, value });
        } else if (this.peek().type === 'lparen') {
          this.advance();
          key = this.parsePipe();
          this.expect('rparen');
          this.expect('colon');
          const value = this.parseAs();
          entries.push({ key, value });
        } else if (this.peek().type === 'format') {
          key = { type: 'format', name: this.advance().value };
          if (this.match('colon')) {
            const value = this.parseAs();
            entries.push({ key, value });
          } else {
            entries.push({ key, value: key });
          }
        } else if (this.peek().type === 'dollar_ident') {
          const varName = this.advance().value;
          key = { type: 'literal', value: varName.slice(1) };
          entries.push({ key, value: { type: 'var_ref', name: varName } });
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

  private parseTry(): ASTNode {
    this.expect('ident', 'try');
    const body = this.parsePostfix();
    let catch_: ASTNode | null = null;
    if (this.peek().type === 'ident' && this.peek().value === 'catch') {
      this.advance();
      catch_ = this.parsePostfix();
    }
    return { type: 'try', body, catch_ };
  }

  private parseDef(): ASTNode {
    this.expect('ident', 'def');
    const name = this.expect('ident').value;
    const params: string[] = [];
    if (this.match('lparen')) {
      if (this.peek().type !== 'rparen') {
        params.push(this.expect('ident').value);
        while (this.match('semicolon')) {
          params.push(this.expect('ident').value);
        }
      }
      this.expect('rparen');
    }
    this.expect('colon');
    const body = this.parsePipe();
    this.expect('semicolon');
    const rest = this.parsePipe();
    return { type: 'def', name, params, body, rest };
  }

  private parseReduce(): ASTNode {
    this.expect('ident', 'reduce');
    const expr = this.parsePostfix();
    this.expect('ident', 'as');
    const pattern = this.parsePattern();
    this.expect('lparen');
    const init = this.parsePipe();
    this.expect('semicolon');
    const update = this.parsePipe();
    this.expect('rparen');
    return { type: 'reduce', expr, pattern, init, update };
  }

  private parseForeach(): ASTNode {
    this.expect('ident', 'foreach');
    const expr = this.parsePostfix();
    this.expect('ident', 'as');
    const pattern = this.parsePattern();
    this.expect('lparen');
    const init = this.parsePipe();
    this.expect('semicolon');
    const update = this.parsePipe();
    let extract: ASTNode | null = null;
    if (this.match('semicolon')) {
      extract = this.parsePipe();
    }
    this.expect('rparen');
    return { type: 'foreach', expr, pattern, init, update, extract };
  }

  private parseLabel(): ASTNode {
    this.expect('ident', 'label');
    const name = this.expect('dollar_ident').value;
    this.expect('pipe');
    const body = this.parsePipe();
    return { type: 'label', name, body };
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

// A sentinel thrown internally to implement `empty`
class JqEmpty {
  static readonly instance = new JqEmpty();
}

// ---------------------------------------------------------------------------
// Hostile-input budgets
//
// Queries and documents can come from untrusted peers, and queries run inside
// the shared worker that services every doc/subscription — an unbounded loop
// there wedges everything. Runaway evaluation must therefore degrade to a
// thrown JqError (surfaced as a per-subscription error result) instead of
// hanging.
// ---------------------------------------------------------------------------

/** Max iterations for the looping builtins until/while/repeat. */
const LOOP_LIMIT = 10000;

/**
 * Global per-query step budget. Ticked on every evaluator activation and on
 * every value produced by unbounded generators (range), so nested loop bombs
 * (e.g. `until` inside `try` inside `until`) and `[range(1e18)]` are bounded
 * even though each individual construct stays under LOOP_LIMIT.
 */
const EVAL_STEP_LIMIT = 5_000_000;
let evalSteps = 0;

function tickSteps(): void {
  if (++evalSteps > EVAL_STEP_LIMIT) {
    throw new JqError(`Query exceeded the evaluation step limit (${EVAL_STEP_LIMIT})`);
  }
}

// A sentinel for label/break
class JqBreak {
  constructor(public label: string, public value: any) {}
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
        if (node.optional) { yield null; break; }
        yield null;
        break;
      }
      if (typeof input !== 'object') {
        if (node.optional) break;
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
      if (Array.isArray(input)) {
        yield input.slice(from, to);
      } else if (typeof input === 'string') {
        yield input.slice(from, to);
      } else {
        yield null;
      }
      break;
    }

    case 'iterate': {
      if (input === null || input === undefined) {
        if (node.optional) break;
        throw new JqError('Cannot iterate over null');
      }
      if (Array.isArray(input)) {
        for (const v of input) yield v;
      } else if (typeof input === 'object') {
        for (const v of Object.values(input)) yield v;
      } else {
        if (node.optional) break;
        throw new JqError(`Cannot iterate over ${typeOf(input)}`);
      }
      break;
    }

    case 'recurse': {
      yield* recurse(input);
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

    case 'unary_minus': {
      for (const v of evaluate(node.expr, input, env)) {
        if (typeof v === 'number') yield -v;
        else throw new JqError(`Cannot negate ${typeOf(v)}`);
      }
      break;
    }

    case 'not': {
      yield !isTruthy(input);
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

    case 'try': {
      try {
        for (const v of evaluate(node.body, input, env)) {
          yield v;
        }
      } catch (e) {
        if (e instanceof JqBreak) throw e;
        if (node.catch_) {
          const errMsg = e instanceof Error ? e.message : String(e);
          yield* evaluate(node.catch_, errMsg, env);
        }
        // else: suppress error (try without catch = optional)
      }
      break;
    }

    case 'optional': {
      try {
        yield* evaluate(node.expr, input, env);
      } catch {
        // suppress
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

    case 'format': {
      yield applyFormat(node.name, input);
      break;
    }

    case 'as_pattern': {
      for (const v of evaluate(node.expr, input, env)) {
        const newEnv = bindPattern(node.pattern, v, env);
        yield* evaluate(node.body, input, newEnv);
      }
      break;
    }

    case 'reduce': {
      let acc: any;
      for (const v of evaluate(node.init, input, env)) { acc = v; break; }
      for (const v of evaluate(node.expr, input, env)) {
        const newEnv = bindPattern(node.pattern, v, env);
        newEnv['$__acc'] = acc;
        for (const newAcc of evaluate(node.update, acc, { ...newEnv })) {
          acc = newAcc;
          break;
        }
      }
      yield acc;
      break;
    }

    case 'foreach': {
      let state: any;
      for (const v of evaluate(node.init, input, env)) { state = v; break; }
      for (const v of evaluate(node.expr, input, env)) {
        const newEnv = bindPattern(node.pattern, v, env);
        for (const newState of evaluate(node.update, state, newEnv)) {
          state = newState;
          break;
        }
        if (node.extract) {
          yield* evaluate(node.extract, state, env);
        } else {
          yield state;
        }
      }
      break;
    }

    case 'label': {
      try {
        yield* evaluate(node.body, input, env);
      } catch (e) {
        if (e instanceof JqBreak && e.label === node.name) {
          // break exits the label without producing output
        } else {
          throw e;
        }
      }
      break;
    }

    case 'break_': {
      throw new JqBreak(node.name, input);
    }

    case 'def': {
      // Store the function definition in env and evaluate rest
      const newEnv = { ...env, [`__fn_${node.name}`]: { params: node.params, body: node.body, closure: env } };
      yield* evaluate(node.rest, input, newEnv);
      break;
    }

    case 'var_ref': {
      if (node.name === '$ENV') { yield {}; break; }
      if (node.name === '$__loc__') { yield { file: '<input>', line: 1 }; break; }
      if (!(node.name in env)) {
        throw new JqError(`Undefined variable ${node.name}`);
      }
      yield env[node.name];
      break;
    }

    case 'limit': {
      let n = 0;
      for (const v of evaluate(node.n, input, env)) { n = v; break; }
      let count = 0;
      for (const v of evaluate(node.expr, input, env)) {
        if (count >= n) break;
        yield v;
        count++;
      }
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

function* recurse(input: any): Generator<any> {
  yield input;
  if (Array.isArray(input)) {
    for (const v of input) yield* recurse(v);
  } else if (input !== null && typeof input === 'object') {
    for (const v of Object.values(input)) yield* recurse(v);
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
    case '-':
      if (typeof l === 'number' && typeof r === 'number') return l - r;
      if (Array.isArray(l) && Array.isArray(r)) return l.filter(x => !r.some(y => deepEqual(x, y)));
      throw new JqError(`Cannot subtract ${typeOf(r)} from ${typeOf(l)}`);
    case '*':
      if (typeof l === 'number' && typeof r === 'number') return l * r;
      if (typeof l === 'object' && typeof r === 'object' && l !== null && r !== null && !Array.isArray(l) && !Array.isArray(r)) {
        return deepMerge(l, r);
      }
      if (typeof l === 'string' && typeof r === 'object' && r !== null) {
        // string * {old: new} = replace
        return l;
      }
      throw new JqError(`Cannot multiply ${typeOf(l)} and ${typeOf(r)}`);
    case '/':
      if (typeof l === 'number' && typeof r === 'number') {
        if (r === 0) throw new JqError('Division by zero');
        return l / r;
      }
      if (typeof l === 'string' && typeof r === 'string') return l.split(r);
      throw new JqError(`Cannot divide ${typeOf(l)} by ${typeOf(r)}`);
    case '%':
      if (typeof l === 'number' && typeof r === 'number') {
        if (r === 0) throw new JqError('Modulo by zero');
        return l % r;
      }
      throw new JqError(`Cannot modulo ${typeOf(l)} by ${typeOf(r)}`);
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

/**
 * Canonical string key for hashing jq values in unique/unique_by/group_by,
 * replacing O(n²) pairwise deepEqual scans. Two values map to the same key
 * iff deepEqual(a, b): object keys are sorted, type prefixes keep e.g. 5 and
 * "5" apart, and NaN (which never deepEquals itself) gets a per-occurrence
 * unique key.
 */
let nanKeyCounter = 0;
function canonicalKey(v: any): string {
  if (v === undefined) return 'u';
  if (v === null) return 'n';
  switch (typeof v) {
    case 'number': return Number.isNaN(v) ? `N${nanKeyCounter++}` : `#${v}`;
    case 'boolean': return v ? 't' : 'f';
    case 'string': return `s${JSON.stringify(v)}`;
  }
  if (Array.isArray(v)) return `[${v.map(canonicalKey).join(',')}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalKey(v[k])}`).join(',')}}`;
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

function deepMerge(a: any, b: any): any {
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) || Array.isArray(b)) {
    return b;
  }
  const result = { ...a };
  for (const k of Object.keys(b)) {
    result[k] = (k in a) ? deepMerge(a[k], b[k]) : b[k];
  }
  return result;
}

function deepContains(a: any, b: any): boolean {
  if (deepEqual(a, b)) return true;
  if (typeof b === 'string' && typeof a === 'string') return a.includes(b);
  if (Array.isArray(a) && Array.isArray(b)) {
    return b.every(bv => a.some(av => deepContains(av, bv)));
  }
  if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null && !Array.isArray(a) && !Array.isArray(b)) {
    return Object.keys(b).every(k => k in a && deepContains(a[k], b[k]));
  }
  return false;
}

function bindPattern(pattern: Pattern, value: any, env: Env): Env {
  const newEnv = { ...env };
  switch (pattern.type) {
    case 'var':
      newEnv[pattern.name] = value;
      break;
    case 'array':
      if (Array.isArray(value)) {
        for (let i = 0; i < pattern.elements.length; i++) {
          Object.assign(newEnv, bindPattern(pattern.elements[i], value[i] ?? null, newEnv));
        }
      }
      break;
    case 'object':
      if (value && typeof value === 'object') {
        for (const entry of pattern.entries) {
          Object.assign(newEnv, bindPattern(entry.value, value[entry.key] ?? null, newEnv));
        }
      }
      break;
  }
  return newEnv;
}

function applyFormat(name: string, input: any): any {
  switch (name) {
    case '@base64':
      return typeof btoa === 'function' ? btoa(String(input)) : Buffer.from(String(input)).toString('base64');
    case '@base64d':
      return typeof atob === 'function' ? atob(String(input)) : Buffer.from(String(input), 'base64').toString();
    case '@uri':
      return encodeURIComponent(String(input));
    case '@html':
      return String(input).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    case '@csv':
      if (Array.isArray(input)) return input.map(v => typeof v === 'string' ? `"${v.replace(/"/g, '""')}"` : String(v ?? '')).join(',');
      return String(input);
    case '@tsv':
      if (Array.isArray(input)) return input.map(v => String(v ?? '').replace(/\t/g, '\\t').replace(/\n/g, '\\n')).join('\t');
      return String(input);
    case '@json':
      return JSON.stringify(input);
    case '@text':
      return String(input ?? '');
    default:
      throw new JqError(`Unknown format: ${name}`);
  }
}

function* evaluateBuiltin(name: string, args: ASTNode[], input: any, env: Env): Generator<any> {
  // Check for user-defined functions first
  const fnKey = `__fn_${name}`;
  if (fnKey in env) {
    const fn = env[fnKey];
    let fnEnv = { ...fn.closure };
    for (let i = 0; i < fn.params.length && i < args.length; i++) {
      // In jq, function args are filters, not values.
      // For simplicity, we bind them as thunks via a wrapper.
      const argNode = args[i];
      fnEnv[`__fn_${fn.params[i]}`] = { params: [], body: argNode, closure: env };
    }
    yield* evaluate(fn.body, input, fnEnv);
    return;
  }

  switch (name) {
    case 'empty':
      // Produce no output
      break;

    case 'error': {
      const msg = args.length > 0 ? first(evaluate(args[0], input, env)) : input;
      throw new JqError(typeof msg === 'string' ? msg : JSON.stringify(msg));
    }

    case 'debug':
      console.debug('DEBUG:', input);
      yield input;
      break;

    case 'input':
    case 'inputs':
      break; // no-op in single-input model

    case 'length':
      if (input === null) yield 0;
      else if (typeof input === 'string') yield input.length;
      else if (Array.isArray(input)) yield input.length;
      else if (typeof input === 'object') yield Object.keys(input).length;
      else if (typeof input === 'number') yield Math.abs(input);
      else yield 0;
      break;

    case 'utf8bytelength':
      yield new TextEncoder().encode(String(input ?? '')).length;
      break;

    case 'keys':
    case 'keys_unsorted':
      if (Array.isArray(input)) yield Array.from({ length: input.length }, (_, i) => i);
      else if (input !== null && typeof input === 'object') {
        yield name === 'keys' ? Object.keys(input).sort() : Object.keys(input);
      }
      else throw new JqError(`${name} is not defined for ${typeOf(input)}`);
      break;

    case 'values':
      if (Array.isArray(input)) yield input;
      else if (input !== null && typeof input === 'object') yield Object.values(input);
      else throw new JqError(`values is not defined for ${typeOf(input)}`);
      break;

    case 'has': {
      const key = first(evaluate(args[0], input, env));
      if (Array.isArray(input)) yield typeof key === 'number' && key >= 0 && key < input.length;
      else if (input !== null && typeof input === 'object') yield String(key) in input;
      else yield false;
      break;
    }

    case 'in': {
      const obj = first(evaluate(args[0], input, env));
      if (Array.isArray(obj)) yield typeof input === 'number' && input >= 0 && input < obj.length;
      else if (obj !== null && typeof obj === 'object') yield String(input) in obj;
      else yield false;
      break;
    }

    case 'contains': {
      const other = first(evaluate(args[0], input, env));
      yield deepContains(input, other);
      break;
    }

    case 'inside': {
      const other = first(evaluate(args[0], input, env));
      yield deepContains(other, input);
      break;
    }

    case 'type':
      yield typeOf(input);
      break;

    case 'infinite': yield Infinity; break;
    case 'nan': yield NaN; break;
    case 'isinfinite': yield input === Infinity || input === -Infinity; break;
    case 'isnan': yield typeof input === 'number' && isNaN(input); break;
    case 'isnormal': yield typeof input === 'number' && isFinite(input) && input !== 0; break;
    case 'isfinite': yield typeof input === 'number' && isFinite(input); break;

    case 'not':
      yield !isTruthy(input);
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

    case 'map_values': {
      if (Array.isArray(input)) {
        const result: any[] = [];
        for (const item of input) {
          result.push(first(evaluate(args[0], item, env)));
        }
        yield result;
      } else if (input !== null && typeof input === 'object') {
        const result: any = {};
        for (const [k, v] of Object.entries(input)) {
          result[k] = first(evaluate(args[0], v, env));
        }
        yield result;
      } else {
        yield first(evaluate(args[0], input, env));
      }
      break;
    }

    case 'select': {
      for (const v of evaluate(args[0], input, env)) {
        if (isTruthy(v)) yield input;
      }
      break;
    }

    case 'recurse':
    case 'recurse_down':
      if (args.length > 0) {
        yield* recurseWith(input, args[0], env);
      } else {
        yield* recurse(input);
      }
      break;

    case 'env':
      yield {};
      break;

    case 'transpose': {
      if (!Array.isArray(input)) { yield []; break; }
      const maxLen = Math.max(...input.map((a: any) => Array.isArray(a) ? a.length : 0));
      const result: any[][] = [];
      for (let i = 0; i < maxLen; i++) {
        result.push(input.map((a: any) => Array.isArray(a) ? (a[i] ?? null) : null));
      }
      yield result;
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

    case 'with_entries': {
      if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
        const entries = Object.entries(input).map(([key, value]) => ({ key, value }));
        const result: any[] = [];
        for (const entry of entries) {
          for (const v of evaluate(args[0], entry, env)) {
            result.push(v);
          }
        }
        const obj: any = {};
        for (const item of result) {
          obj[String(item.key ?? item.name)] = item.value ?? null;
        }
        yield obj;
      }
      break;
    }

    case 'flatten': {
      if (!Array.isArray(input)) { yield input; break; }
      const depth = args.length > 0 ? first(evaluate(args[0], input, env)) : 1;
      yield flattenArray(input, depth);
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

    case 'any': {
      if (args.length > 0) {
        if (!Array.isArray(input)) { yield false; break; }
        let found = false;
        for (const item of input) {
          for (const v of evaluate(args[0], item, env)) {
            if (isTruthy(v)) { found = true; break; }
          }
          if (found) break;
        }
        yield found;
      } else {
        if (Array.isArray(input)) yield input.some(isTruthy);
        else yield isTruthy(input);
      }
      break;
    }

    case 'all': {
      if (args.length > 0) {
        if (!Array.isArray(input)) { yield true; break; }
        let allTrue = true;
        for (const item of input) {
          for (const v of evaluate(args[0], item, env)) {
            if (!isTruthy(v)) { allTrue = false; break; }
          }
          if (!allTrue) break;
        }
        yield allTrue;
      } else {
        if (Array.isArray(input)) yield input.every(isTruthy);
        else yield isTruthy(input);
      }
      break;
    }

    case 'unique': {
      if (!Array.isArray(input)) { yield input; break; }
      const seen = new Set<string>();
      const result: any[] = [];
      for (const v of input) {
        const ck = canonicalKey(v);
        if (!seen.has(ck)) {
          seen.add(ck);
          result.push(v);
        }
      }
      yield result;
      break;
    }

    case 'unique_by': {
      if (!Array.isArray(input)) { yield input; break; }
      const seen = new Set<string>();
      const result: any[] = [];
      for (const item of input) {
        const ck = canonicalKey(first(evaluate(args[0], item, env)));
        if (!seen.has(ck)) {
          seen.add(ck);
          result.push(item);
        }
      }
      yield result;
      break;
    }

    case 'group_by': {
      if (!Array.isArray(input)) { yield input; break; }
      const groups = new Map<string, { key: any; items: any[] }>();
      for (const item of input) {
        const k = first(evaluate(args[0], item, env));
        const ck = canonicalKey(k);
        const existing = groups.get(ck);
        if (existing) existing.items.push(item);
        else groups.set(ck, { key: k, items: [item] });
      }
      const sorted = [...groups.values()].sort((a, b) => compare(a.key, b.key));
      yield sorted.map(g => g.items);
      break;
    }

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

    case 'reverse':
      if (Array.isArray(input)) yield [...input].reverse();
      else if (typeof input === 'string') yield input.split('').reverse().join('');
      else yield input;
      break;

    case 'min':
    case 'min_by': {
      if (!Array.isArray(input) || input.length === 0) { yield null; break; }
      if (args.length > 0) {
        let minItem = input[0];
        let minKey = first(evaluate(args[0], input[0], env));
        for (let i = 1; i < input.length; i++) {
          const k = first(evaluate(args[0], input[i], env));
          if (compare(k, minKey) < 0) { minItem = input[i]; minKey = k; }
        }
        yield minItem;
      } else {
        yield input.reduce((a: any, b: any) => compare(a, b) <= 0 ? a : b);
      }
      break;
    }

    case 'max':
    case 'max_by': {
      if (!Array.isArray(input) || input.length === 0) { yield null; break; }
      if (args.length > 0) {
        let maxItem = input[0];
        let maxKey = first(evaluate(args[0], input[0], env));
        for (let i = 1; i < input.length; i++) {
          const k = first(evaluate(args[0], input[i], env));
          if (compare(k, maxKey) > 0) { maxItem = input[i]; maxKey = k; }
        }
        yield maxItem;
      } else {
        yield input.reduce((a: any, b: any) => compare(a, b) >= 0 ? a : b);
      }
      break;
    }

    case 'first':
      if (args.length > 0) {
        for (const v of evaluate(args[0], input, env)) { yield v; return; }
      } else {
        if (Array.isArray(input) && input.length > 0) yield input[0];
        else yield null;
      }
      break;

    case 'last':
      if (args.length > 0) {
        let lastVal: any = null;
        for (const v of evaluate(args[0], input, env)) { lastVal = v; }
        yield lastVal;
      } else {
        if (Array.isArray(input) && input.length > 0) yield input[input.length - 1];
        else yield null;
      }
      break;

    case 'nth': {
      const n = first(evaluate(args[0], input, env));
      const expr = args.length > 1 ? args[1] : { type: 'iterate' as const, optional: false };
      let count = 0;
      for (const v of evaluate(expr, input, env)) {
        if (count === n) { yield v; return; }
        count++;
      }
      break;
    }

    case 'range': {
      // range yields without re-entering evaluate(), so it must tick the
      // step budget itself or [range(1e18)] would hang the worker.
      if (args.length === 1) {
        const n = first(evaluate(args[0], input, env));
        for (let i = 0; i < n; i++) { tickSteps(); yield i; }
      } else if (args.length >= 2) {
        const a = first(evaluate(args[0], input, env));
        const b = first(evaluate(args[1], input, env));
        const step = args.length > 2 ? first(evaluate(args[2], input, env)) : 1;
        if (step > 0) for (let i = a; i < b; i += step) { tickSteps(); yield i; }
        else if (step < 0) for (let i = a; i > b; i += step) { tickSteps(); yield i; }
      }
      break;
    }

    case 'floor': yield Math.floor(input); break;
    case 'ceil': yield Math.ceil(input); break;
    case 'round': yield Math.round(input); break;
    case 'fabs': yield Math.abs(input); break;
    case 'sqrt': yield Math.sqrt(input); break;
    case 'pow': {
      const base = first(evaluate(args[0], input, env));
      const exp = first(evaluate(args[1], input, env));
      yield Math.pow(base, exp);
      break;
    }
    case 'log': yield Math.log(input); break;
    case 'log2': yield Math.log2(input); break;
    case 'log10': yield Math.log10(input); break;
    case 'exp': yield Math.exp(input); break;
    case 'exp2': yield Math.pow(2, input); break;

    case 'ascii_downcase':
      yield typeof input === 'string' ? input.toLowerCase() : input;
      break;

    case 'ascii_upcase':
      yield typeof input === 'string' ? input.toUpperCase() : input;
      break;

    case 'ltrimstr': {
      const s = first(evaluate(args[0], input, env));
      yield typeof input === 'string' && typeof s === 'string' && input.startsWith(s) ? input.slice(s.length) : input;
      break;
    }

    case 'rtrimstr': {
      const s = first(evaluate(args[0], input, env));
      yield typeof input === 'string' && typeof s === 'string' && input.endsWith(s) ? input.slice(0, -s.length) : input;
      break;
    }

    case 'startswith': {
      const s = first(evaluate(args[0], input, env));
      yield typeof input === 'string' && input.startsWith(String(s));
      break;
    }

    case 'endswith': {
      const s = first(evaluate(args[0], input, env));
      yield typeof input === 'string' && input.endsWith(String(s));
      break;
    }

    case 'split': {
      const sep = first(evaluate(args[0], input, env));
      yield typeof input === 'string' ? input.split(String(sep)) : input;
      break;
    }

    case 'join': {
      const sep = first(evaluate(args[0], input, env));
      yield Array.isArray(input) ? input.map(v => v === null ? '' : String(v)).join(String(sep)) : input;
      break;
    }

    case 'test': {
      const pattern = first(evaluate(args[0], input, env));
      const flags = args.length > 1 ? String(first(evaluate(args[1], input, env))) : '';
      yield new RegExp(String(pattern), flags).test(String(input));
      break;
    }

    case 'match': {
      const pattern = first(evaluate(args[0], input, env));
      const flags = args.length > 1 ? String(first(evaluate(args[1], input, env))) : '';
      const m = String(input).match(new RegExp(String(pattern), flags));
      if (m) {
        yield {
          offset: m.index,
          length: m[0].length,
          string: m[0],
          captures: (m.slice(1) || []).map((c, i) => ({
            offset: m.index! + (m[0].indexOf(c) >= 0 ? m[0].indexOf(c) : 0),
            length: c ? c.length : 0,
            string: c ?? null,
            name: m.groups ? Object.keys(m.groups).find(k => m.groups![k] === c) ?? null : null,
          })),
        };
      } else {
        throw new JqError(`match: pattern not found`);
      }
      break;
    }

    case 'capture': {
      const pattern = first(evaluate(args[0], input, env));
      const flags = args.length > 1 ? String(first(evaluate(args[1], input, env))) : '';
      const m = String(input).match(new RegExp(String(pattern), flags));
      yield m?.groups ? { ...m.groups } : {};
      break;
    }

    case 'scan': {
      const pattern = first(evaluate(args[0], input, env));
      const re = new RegExp(String(pattern), 'g');
      const str = String(input);
      let m;
      while ((m = re.exec(str)) !== null) {
        yield m.length > 1 ? m.slice(1) : m[0];
        if (m[0] === '') {
          // Zero-width match (e.g. scan("") or scan("a*")): exec left
          // lastIndex unchanged, so force progress — by a whole code point to
          // avoid splitting surrogate pairs — or the loop never terminates.
          const cp = str.codePointAt(re.lastIndex);
          re.lastIndex += cp !== undefined && cp > 0xffff ? 2 : 1;
        }
      }
      break;
    }

    case 'splits': {
      const pattern = first(evaluate(args[0], input, env));
      const flags = args.length > 1 ? String(first(evaluate(args[1], input, env))) : '';
      const parts = String(input).split(new RegExp(String(pattern), flags));
      for (const p of parts) yield p;
      break;
    }

    case 'sub': {
      const pattern = first(evaluate(args[0], input, env));
      const repl = first(evaluate(args[1], input, env));
      const flags = args.length > 2 ? String(first(evaluate(args[2], input, env))) : '';
      yield String(input).replace(new RegExp(String(pattern), flags), String(repl));
      break;
    }

    case 'gsub': {
      const pattern = first(evaluate(args[0], input, env));
      const repl = first(evaluate(args[1], input, env));
      const flags = args.length > 2 ? String(first(evaluate(args[2], input, env))) : 'g';
      const f = flags.includes('g') ? flags : flags + 'g';
      yield String(input).replace(new RegExp(String(pattern), f), String(repl));
      break;
    }

    case 'tostring':
      yield input === null ? 'null' : typeof input === 'string' ? input : JSON.stringify(input);
      break;

    case 'tonumber':
      if (typeof input === 'number') yield input;
      else if (typeof input === 'string') {
        const n = Number(input);
        if (isNaN(n)) throw new JqError(`Cannot convert "${input}" to number`);
        yield n;
      }
      else throw new JqError(`Cannot convert ${typeOf(input)} to number`);
      break;

    case 'tojson':
      yield JSON.stringify(input);
      break;

    case 'fromjson':
      yield JSON.parse(String(input));
      break;

    case 'ascii':
      yield typeof input === 'string' && input.length > 0 ? input.charCodeAt(0) : null;
      break;

    case 'explode':
      yield typeof input === 'string' ? Array.from(input).map(c => c.codePointAt(0)!) : [];
      break;

    case 'implode':
      yield Array.isArray(input) ? String.fromCodePoint(...input) : '';
      break;

    case 'indices':
    case 'index':
    case 'rindex': {
      const target = first(evaluate(args[0], input, env));
      const indices: number[] = [];
      if (typeof input === 'string' && typeof target === 'string') {
        let pos = 0;
        while (true) {
          const idx = input.indexOf(target, pos);
          if (idx === -1) break;
          indices.push(idx);
          pos = idx + 1;
        }
      } else if (Array.isArray(input)) {
        for (let i = 0; i < input.length; i++) {
          if (deepEqual(input[i], target)) indices.push(i);
        }
      }
      if (name === 'indices') yield indices;
      else if (name === 'index') yield indices.length > 0 ? indices[0] : null;
      else yield indices.length > 0 ? indices[indices.length - 1] : null;
      break;
    }

    case 'IN': {
      if (args.length >= 1) {
        let found = false;
        for (const v of evaluate(args[0], input, env)) {
          if (deepEqual(input, v)) { found = true; break; }
        }
        yield found;
      }
      break;
    }

    case 'limit': {
      // limit(n; expr) form handled in parser as node type, but also as builtin
      const n = first(evaluate(args[0], input, env));
      const expr = args[1];
      let count = 0;
      for (const v of evaluate(expr, input, env)) {
        if (count >= n) break;
        yield v;
        count++;
      }
      break;
    }

    case 'until': {
      let state = input;
      for (let i = 0; ; i++) {
        if (i >= LOOP_LIMIT) throw new JqError(`until: exceeded ${LOOP_LIMIT} iterations`);
        const cond = first(evaluate(args[0], state, env));
        if (isTruthy(cond)) break;
        state = first(evaluate(args[1], state, env));
      }
      yield state;
      break;
    }

    case 'while_': // jq's `while` is a keyword-ish
    case 'while': {
      let state = input;
      for (let i = 0; ; i++) {
        if (i >= LOOP_LIMIT) throw new JqError(`while: exceeded ${LOOP_LIMIT} iterations`);
        const cond = first(evaluate(args[0], state, env));
        if (!isTruthy(cond)) break;
        yield state;
        state = first(evaluate(args[1], state, env));
      }
      break;
    }

    case 'repeat': {
      let state = input;
      for (let i = 0; i < LOOP_LIMIT; i++) { // safety limit
        yield state;
        state = first(evaluate(args[0], state, env));
      }
      break;
    }

    case 'paths': {
      if (args.length > 0) {
        yield* allPaths(input, [], args[0], env);
      } else {
        yield* allPathsSimple(input, []);
      }
      break;
    }

    case 'leaf_paths': {
      yield* leafPaths(input, []);
      break;
    }

    case 'path': {
      yield* pathsOf(args[0], input, env);
      break;
    }

    case 'getpath': {
      const p = first(evaluate(args[0], input, env));
      yield getPath(input, p);
      break;
    }

    case 'setpath': {
      const p = first(evaluate(args[0], input, env));
      const v = first(evaluate(args[1], input, env));
      yield setPath(input, p, v);
      break;
    }

    case 'delpaths': {
      const ps = first(evaluate(args[0], input, env));
      if (!Array.isArray(ps)) { yield input; break; }
      // Sort paths longest-first to avoid index shifting issues
      const sorted = [...ps].sort((a, b) => b.length - a.length);
      let result = structuredClone(input);
      for (const p of sorted) {
        result = delPath(result, p);
      }
      yield result;
      break;
    }

    case 'builtins':
      yield BUILTIN_NAMES;
      break;

    case 'null':
      yield null;
      break;

    case 'true':
      yield true;
      break;

    case 'false':
      yield false;
      break;

    case 'objects': if (typeof input === 'object' && input !== null && !Array.isArray(input)) yield input; break;
    case 'arrays': if (Array.isArray(input)) yield input; break;
    case 'strings': if (typeof input === 'string') yield input; break;
    case 'numbers': if (typeof input === 'number') yield input; break;
    case 'booleans': if (typeof input === 'boolean') yield input; break;
    case 'nulls': if (input === null) yield input; break;
    case 'iterables':
      if (Array.isArray(input) || (input !== null && typeof input === 'object')) yield input;
      break;
    case 'scalars':
      if (input === null || typeof input !== 'object') yield input;
      break;

    case 'modulemeta':
      yield null;
      break;

    case 'abs':
      yield typeof input === 'number' ? Math.abs(input) : input;
      break;

    default:
      throw new JqError(`Unknown function: ${name}`);
  }
}

function* recurseWith(input: any, filter: ASTNode, env: Env): Generator<any> {
  yield input;
  try {
    for (const v of evaluate(filter, input, env)) {
      yield* recurseWith(v, filter, env);
    }
  } catch {
    // stop recursion on error
  }
}

function* allPathsSimple(input: any, path: (string | number)[]): Generator<any> {
  yield path;
  if (Array.isArray(input)) {
    for (let i = 0; i < input.length; i++) {
      yield* allPathsSimple(input[i], [...path, i]);
    }
  } else if (input !== null && typeof input === 'object') {
    for (const k of Object.keys(input)) {
      yield* allPathsSimple(input[k], [...path, k]);
    }
  }
}

function* allPaths(input: any, path: (string | number)[], filter: ASTNode, env: Env): Generator<any> {
  const result = first(evaluate(filter, input, env));
  if (isTruthy(result)) yield path;
  if (Array.isArray(input)) {
    for (let i = 0; i < input.length; i++) {
      yield* allPaths(input[i], [...path, i], filter, env);
    }
  } else if (input !== null && typeof input === 'object') {
    for (const k of Object.keys(input)) {
      yield* allPaths(input[k], [...path, k], filter, env);
    }
  }
}

function* leafPaths(input: any, path: (string | number)[]): Generator<any> {
  if (input === null || typeof input !== 'object') {
    yield path;
    return;
  }
  if (Array.isArray(input)) {
    if (input.length === 0) { yield path; return; }
    for (let i = 0; i < input.length; i++) {
      yield* leafPaths(input[i], [...path, i]);
    }
  } else {
    const keys = Object.keys(input);
    if (keys.length === 0) { yield path; return; }
    for (const k of keys) {
      yield* leafPaths(input[k], [...path, k]);
    }
  }
}

function* pathsOf(node: ASTNode, input: any, env: Env): Generator<any> {
  // Simple path extraction for field/index/pipe chains
  if (node.type === 'identity') {
    yield [];
    return;
  }
  if (node.type === 'field') {
    yield [node.name];
    return;
  }
  if (node.type === 'iterate') {
    if (Array.isArray(input)) {
      for (let i = 0; i < input.length; i++) yield [i];
    } else if (input !== null && typeof input === 'object') {
      for (const k of Object.keys(input)) yield [k];
    }
    return;
  }
  if (node.type === 'pipe') {
    for (const lPath of pathsOf(node.left, input, env)) {
      const intermediate = getPath(input, lPath);
      for (const rPath of pathsOf(node.right, intermediate, env)) {
        yield [...lPath, ...rPath];
      }
    }
    return;
  }
  // For complex expressions, just yield the path to matching values
  throw new JqError(`path() does not support this expression type`);
}

function getPath(input: any, path: any): any {
  if (!Array.isArray(path)) return null;
  let current = input;
  for (const key of path) {
    if (current === null || current === undefined) return null;
    current = typeof current === 'object' ? current[key] ?? null : null;
  }
  return current;
}

function setPath(input: any, path: any, value: any): any {
  if (!Array.isArray(path) || path.length === 0) return value;
  const result = Array.isArray(input) ? [...input] : { ...input };
  const key = path[0];
  result[key] = setPath(result[key] ?? (typeof path[1] === 'number' ? [] : {}), path.slice(1), value);
  return result;
}

function delPath(input: any, path: any[]): any {
  if (!Array.isArray(path) || path.length === 0) return undefined;
  if (path.length === 1) {
    if (Array.isArray(input)) {
      const arr = [...input];
      arr.splice(path[0] as number, 1);
      return arr;
    }
    if (typeof input === 'object' && input !== null) {
      const obj = { ...input };
      delete obj[path[0]];
      return obj;
    }
    return input;
  }
  const key = path[0];
  if (input === null || input === undefined || typeof input !== 'object') return input;
  const result = Array.isArray(input) ? [...input] : { ...input };
  result[key] = delPath(result[key], path.slice(1));
  return result;
}

function flattenArray(arr: any[], depth: number): any[] {
  if (depth <= 0) return arr;
  const result: any[] = [];
  for (const item of arr) {
    if (Array.isArray(item)) {
      result.push(...flattenArray(item, depth - 1));
    } else {
      result.push(item);
    }
  }
  return result;
}

function first(gen: Generator<any>): any {
  const result = gen.next();
  return result.done ? null : result.value;
}

const BUILTIN_NAMES = [
  'length', 'utf8bytelength', 'keys', 'keys_unsorted', 'values', 'has', 'in', 'contains', 'inside',
  'type', 'infinite', 'nan', 'isinfinite', 'isnan', 'isnormal', 'isfinite',
  'not', 'map', 'map_values', 'select', 'empty', 'error', 'debug',
  'to_entries', 'from_entries', 'with_entries', 'flatten', 'add', 'any', 'all',
  'unique', 'unique_by', 'group_by', 'sort', 'sort_by', 'reverse',
  'min', 'min_by', 'max', 'max_by', 'first', 'last', 'nth', 'range',
  'floor', 'ceil', 'round', 'fabs', 'sqrt', 'pow', 'log', 'log2', 'log10', 'exp', 'exp2',
  'ascii_downcase', 'ascii_upcase', 'ltrimstr', 'rtrimstr', 'startswith', 'endswith',
  'split', 'join', 'test', 'match', 'capture', 'scan', 'splits', 'sub', 'gsub',
  'tostring', 'tonumber', 'tojson', 'fromjson', 'ascii', 'explode', 'implode',
  'indices', 'index', 'rindex', 'IN', 'limit', 'until', 'while', 'repeat',
  'paths', 'leaf_paths', 'path', 'getpath', 'setpath', 'delpaths',
  'recurse', 'recurse_down', 'env', 'transpose', 'input', 'inputs',
  'builtins', 'abs', 'modulemeta',
  'objects', 'arrays', 'strings', 'numbers', 'booleans', 'nulls', 'iterables', 'scalars',
];

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
    try {
      for (const v of evaluate(ast, input, {})) {
        if (v !== undefined) results.push(v);
      }
    } catch (e) {
      if (e instanceof JqEmpty || e instanceof JqBreak) return results;
      throw e;
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
