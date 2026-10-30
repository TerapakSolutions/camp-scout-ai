// The e2e specs run against the PRODUCTION server (`npm run build:fly` + `npx tsx server/production.mjs`
// on PORT=5173), the same artifact Fly ships — see the `e2e` job in .github/workflows/ci.yml.
//
// The app sits behind a Google sign-in gate. The specs don't go through Google: the `mintSession` task
// signs a `cs_session` cookie with the app's REAL `signSession`, so the server's own verifySession +
// /camp-scout-runtime.js path decides the user is signed in. Server and Cypress must share
// SESSION_SECRET (any dummy >= 16 chars; CI sets an e2e-only value — never a real secret).
const { require: tsxRequire } = require('tsx/cjs/api')

module.exports = {
  e2e: {
    baseUrl: 'http://localhost:5173',
    setupNodeEvents(on) {
      on('task', {
        mintSession() {
          const { signSession } = tsxRequire('./src/server/auth/jwt.ts', __filename)
          return signSession({ uid: 'e2e-user', email: 'e2e@example.com', name: 'E2E User' })
        },
      })
    },
  },
}
