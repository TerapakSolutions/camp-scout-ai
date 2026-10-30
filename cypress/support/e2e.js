// Loaded before every spec file (see cypress.config.js for how the server is served).

import './commands'

// Sign in before EVERY test: testIsolation clears cookies between tests. The cookie is minted by the
// app's real signSession (task in cypress.config.js), so the server decides auth exactly as in prod.
beforeEach(() => {
  cy.task('mintSession').then((token) => {
    cy.setCookie('cs_session', String(token))
  })
})
