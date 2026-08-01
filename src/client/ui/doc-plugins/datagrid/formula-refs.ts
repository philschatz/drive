import type { CellRef, FormulaAST, FormulaNode, RangeRef } from './formula-ast';

// ─── Utilities ───────────────────────────────────────────────────────────────

/** Single home for the AST walk: `visit` recurses via the `map` it's given. */
export function mapFormulaNodes<T>(
  node: FormulaNode,
  visit: (node: FormulaNode, map: (n: FormulaNode) => T) => T,
): T {
  const map = (n: FormulaNode): T => mapFormulaNodes(n, visit);
  return visit(node, map);
}

/** Extract all cell references and range references from an AST. */
export function extractCellRefs(ast: FormulaAST): (CellRef | RangeRef)[] {
  const refs: (CellRef | RangeRef)[] = [];
  mapFormulaNodes(ast.body, (node, map) => {
    switch (node.type) {
      case 'cellRef':
      case 'range':
        // Range endpoints aren't recursed, so refs inside a range aren't collected twice.
        refs.push(node);
        break;
      case 'binary': map(node.left); map(node.right); break;
      case 'unary': map(node.operand); break;
      case 'function': node.args.forEach(map); break;
      case 'paren': map(node.expr); break;
    }
    return 0;
  });
  return refs;
}
