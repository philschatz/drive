/** Type into the active CodeMirror cell editor, waiting for it to be ready. */
function typeInCell(text: string) {
  cy.get('.cell-editor-cm .cm-content', { timeout: 5000 }).should('exist').type(text, { delay: 30 });
}

/** Type into the formula bar CodeMirror editor. */
function typeInFormulaBar(text: string) {
  cy.get('.formula-bar-cm .cm-content', { timeout: 5000 }).should('exist').type(text, { delay: 30 });
}

describe('DataGrid', () => {
  before(() => {
    cy.visit('/');
    cy.window().then(win => {
      cy.stub(win, 'prompt').returns('Test Spreadsheet');
    });
    cy.contains('button', 'New').click();
    cy.get('[role="menuitem"]').contains('Spreadsheet').click();
    cy.url({ timeout: 15000 }).should('include', '#/datagrids/');
    cy.get('.datagrid-table', { timeout: 10000 }).should('exist');
  });

  it('spreadsheet CRUD', () => {
    // Click cell A1 and type a value
    cy.get('[data-cell-col="0"][data-cell-row="0"]').dblclick();
    typeInCell('Hello{enter}');
    cy.get('[data-cell-col="0"][data-cell-row="0"]').should('contain.text', 'Hello');

    // Type a number in B1
    cy.get('[data-cell-col="1"][data-cell-row="0"]').dblclick();
    typeInCell('42{enter}');
    cy.get('[data-cell-col="1"][data-cell-row="0"]').should('contain.text', '42');

    // Type a number in B2
    cy.get('[data-cell-col="1"][data-cell-row="1"]').dblclick();
    typeInCell('8{enter}');
    cy.get('[data-cell-col="1"][data-cell-row="1"]').should('contain.text', '8');

    // Wait a moment for the HF worker to process all cell values via automerge sync
    cy.wait(500);

    // Type a formula in B3 that sums B1:B2
    cy.get('[data-cell-col="1"][data-cell-row="2"]').dblclick();
    typeInCell('=B1+B2{enter}');
    // Formula evaluation is async via the HF worker — allow extra time
    cy.get('[data-cell-col="1"][data-cell-row="2"]', { timeout: 10000 }).should('contain.text', '50');

    // Edit A1 via the formula bar — click cell first, then click formula bar
    cy.get('[data-cell-col="0"][data-cell-row="0"]').click();
    cy.get('.formula-bar-cm .cm-content', { timeout: 5000 }).should('exist').click();
    typeInFormulaBar('{selectAll}Updated{enter}');
    cy.get('[data-cell-col="0"][data-cell-row="0"]').should('contain.text', 'Updated');

    // Rename the spreadsheet
    cy.get('input.text-lg').clear().type('Renamed Sheet').blur();
    cy.get('input.text-lg').should('have.value', 'Renamed Sheet');
  });
});
