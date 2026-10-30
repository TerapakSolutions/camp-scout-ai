// SKIPPED 2026-10-30: job-search template leftover from the initial commit. CampScout has no
// /dashboard route and no 'Completed Applications' / 'Jobs in Queue' text anywhere in src/, so this
// can never pass. Delete it, or rewrite it against a real CampScout page.
describe.skip('Status Cards', () => {
  it('are visible on the dashboard', () => {
    cy.visit('/dashboard');
    cy.contains('Completed Applications');
    cy.contains('Jobs in Queue');
    cy.contains('Preview Applications');
  });

  // If status cards are clickable and should navigate or update UI, add:
  // it('navigates or updates UI when a status card is clicked', () => {
  //   cy.visit('/dashboard');
  //   cy.contains('Completed Applications').click();
  //   // Assert navigation or UI update here
  // });
});