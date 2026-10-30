// SKIPPED 2026-10-30: job-search template leftover from the initial commit. CampScout has no
// /dashboard route and no 'Completed Applications' / 'Jobs in Queue' text anywhere in src/, so this
// can never pass. Delete it, or rewrite it against a real CampScout page.
describe.skip('Dashboard Page', () => {
  it('loads and displays main stats', () => {
    cy.visit('/dashboard');
    cy.contains('Dashboard');
    cy.contains('Completed Applications');
    cy.contains('Jobs in Queue');
    cy.contains('Preview Applications');
  });

  it('navigates to Settings and back', () => {
    cy.visit('/dashboard');
    cy.contains('Settings').click();
    cy.url().should('include', '/settings');
    cy.contains('Settings');
    cy.contains('Dashboard').click();
    cy.url().should('include', '/dashboard');
  });
}); 