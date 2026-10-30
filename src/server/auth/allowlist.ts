/**
 * Access control: if ALLOWED_EMAILS is set (comma-separated), only those emails
 * may sign in / stay signed in. Unset => open sign-up (public). Keeps the app
 * private to a fixed list — important while Pushover routes to one device.
 *
 * Lives in its own module (no db import graph) so lightweight routes such as
 * the runtime-config script can enforce it without pulling in drizzle/SQLite.
 */
export function isEmailAllowed(email: string | null | undefined): boolean {
  const raw = process.env.ALLOWED_EMAILS?.trim()
  if (!raw) return true // no allowlist configured => open
  const allowed = raw
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
  return allowed.includes((email ?? '').trim().toLowerCase())
}
