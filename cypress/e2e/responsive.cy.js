// SKIPPED 2026-10-30: job-search template leftover from the initial commit. CampScout has no
// /dashboard route and no 'Completed Applications' / 'Jobs in Queue' text anywhere in src/, so this
// can never pass. Delete it, or rewrite it against a real CampScout page.
describe.skip('Responsive Dashboard', () => {
  it('shows summary cards on mobile', () => {
    cy.viewport('iphone-6');
    cy.visit('/dashboard');
    cy.contains('Dashboard');
    cy.contains('Completed Applications');
    cy.contains('Jobs in Queue');
    cy.contains('Preview Applications');
    // Optionally, check for mobile-specific layout, e.g.:
    // cy.get('.sidebar').should('not.be.visible');
  });

  it('shows summary cards on desktop', () => {
    cy.viewport(1280, 800);
    cy.visit('/dashboard');
    cy.contains('Dashboard');
    cy.contains('Completed Applications');
    cy.contains('Jobs in Queue');
    cy.contains('Preview Applications');
    // Optionally, check for desktop-specific layout
  });
});