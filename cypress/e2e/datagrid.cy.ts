describe('DataGrid', () => {
  // Helper: type into the inline cell editor (CodeMirror contenteditable)
  function typeInCellEditor(text: string) {
    cy.get('.cell-editor-cm .cm-content').type(text, { force: true });
  }

  before(() => {
    cy.visit('/');
    cy.contains('New spreadsheet').click();
    cy.get('a[href^="/datagrids/"]', { timeout: 10000 }).first().invoke('attr', 'href').then((href) => {
      const docId = href!.replace(/.*\/datagrids\//, '');
      // The repo singleton is destroyed on full-page navigation. The new
      // page's repo must find the doc via server sync (IndexedDB may be
      // empty). Poll until the server confirms it has the doc.
      const waitForServerSync = (): Cypress.Chainable =>
        cy.request('/api/docs').then(({ body }) => {
          if (!body.some((d: any) => d.documentId === docId)) {
            return cy.wait(500).then(waitForServerSync);
          }
        });
      waitForServerSync();
      cy.visit(href!);
      cy.get('.datagrid-table', { timeout: 10000 }).should('exist');
    });
  });

  // Single test to avoid Chromium renderer crashes from memory pressure
  it('basic cell editing', () => {
    const cell = (col: number, row: number) =>
      cy.get(`[data-cell-col="${col}"][data-cell-row="${row}"]`);

    // Click A1, type one char to start editing, then continue in editor
    cell(0, 0).click();
    cy.get('.formula-cell-label').should('have.text', 'A1');
    cy.get('.datagrid-container').type('H');
    cy.get('.cell-editor-cm').should('exist');
    typeInCellEditor('ello');
    cy.get('.cell-editor-cm .cm-line').should('have.text', 'Hello');

    // Formula bar syncs with cell editor
    cy.get('.formula-bar .cm-line').should('have.text', 'Hello');

    // Enter commits and moves down
    typeInCellEditor('{enter}');
    cell(0, 0).should('contain.text', 'Hello');
    cy.get('.formula-cell-label').should('have.text', 'A2');

    // Type in A2, then Escape to cancel
    cy.get('.datagrid-container').type('N');
    typeInCellEditor('ope{esc}');
    cell(0, 1).should('not.contain.text', 'Nope');

    // Double-click A1 to edit existing value
    cell(0, 0).dblclick();
    cy.get('.cell-editor-cm').should('exist');
    cy.get('.cell-editor-cm .cm-line').should('have.text', 'Hello');
    typeInCellEditor('{esc}');

    // Type a formula in B1
    cell(1, 0).click();
    cy.get('.datagrid-container').type('=');
    typeInCellEditor('1+2{enter}');
    cell(1, 0).should('contain.text', '3');

    // Arrow key navigation
    cell(0, 0).click();
    cy.get('.datagrid-container').type('{rightArrow}');
    cy.get('.formula-cell-label').should('have.text', 'B1');
    cy.get('.datagrid-container').type('{downArrow}');
    cy.get('.formula-cell-label').should('have.text', 'B2');

    // Delete key clears a cell
    cell(0, 0).click();
    cy.get('.datagrid-container').type('X');
    typeInCellEditor('{enter}');
    cell(0, 0).should('contain.text', 'X');
    cell(0, 0).click();
    cy.get('.datagrid-container').type('{del}');
    cell(0, 0).should('not.contain.text', 'X');

    // Formula bar shows a CodeMirror editor when a cell is selected
    cell(2, 0).click();
    cy.get('.formula-cell-label').should('have.text', 'C1');
    cy.get('.formula-bar-cm', { timeout: 5000 }).should('exist');

    // Enter a formula in C1 referencing A1
    cy.get('.datagrid-container').type('=');
    typeInCellEditor('A1{enter}');

    // Select C1 — formula bar CM shows the formula (not editing)
    cell(2, 0).click();
    cy.get('.formula-bar-cm .cm-line', { timeout: 3000 }).should('have.text', '=A1');

    // No ref highlights while only viewing (editingCell is null)
    cell(0, 0).should('not.have.class', 'formula-ref-highlight');

    // Click the formula bar → editing starts → A1 gets a ref highlight border
    cy.get('.formula-bar-cm .cm-content', { timeout: 3000 }).click();
    cell(0, 0).should('have.class', 'formula-ref-highlight');

    // Escape cancels editing and clears ref highlights
    cy.get('.formula-bar-cm .cm-content').type('{esc}');
    cell(0, 0).should('not.have.class', 'formula-ref-highlight');
  });
});
