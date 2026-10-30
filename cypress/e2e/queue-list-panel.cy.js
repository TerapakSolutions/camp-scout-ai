// SKIPPED 2026-10-30: job-search template leftover from the initial commit. CampScout has no
// /dashboard route and no 'Completed Applications' / 'Jobs in Queue' text anywhere in src/, so this
// can never pass. Delete it, or rewrite it against a real CampScout page.
describe.skip('Queue List Panel', () => {
  it('shows jobs in the queue', () => {
    cy.visit('/dashboard');
    // Adjust the selector/text below to match your panel header or a job row
    cy.contains('Jobs in Queue'); // Panel header
    // Optionally, check for a job row if you expect jobs to be present
    // cy.get('.queue-list-panel-selector').find('li').should('have.length.greaterThan', 0);
  });
});