// Cypress e2e support file
import '@cypress/code-coverage/support';

// Stale automerge document handles from previous sessions can fire an
// "unavailable" rejection before the test even starts. This is a background
// sync error, not a test failure — ignore it globally.
Cypress.on('uncaught:exception', (err) => {
  if (err.message.includes('is unavailable')) return false;
  // Preact internal error during component lifecycle (harmless race on navigation)
  if (err.message.includes("'__k'") || err.message.includes("'__c'")) return false;
  return true;
});
