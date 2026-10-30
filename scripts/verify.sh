#!/usr/bin/env bash
# Camp Scout AI — repeatable project verification
# Runs typecheck, lint, test (with the coverage floor) and the production build.
# A missing required npm script is a FAILURE, never a skip.
# Exits non-zero on the first failure. Performs no git or deployment actions.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

has_npm_script() {
  node -e "
    const scripts = require('./package.json').scripts || {};
    process.exit(Object.prototype.hasOwnProperty.call(scripts, process.argv[1]) ? 0 : 1);
  " "$1"
}

section() {
  echo ""
  echo "========================================"
  echo "  $1"
  echo "========================================"
}

pass() {
  echo ""
  echo "✓ PASS: $1"
}

fail() {
  echo ""
  echo "✗ FAIL: $1"
  exit 1
}

# Every required script must exist. A missing one FAILS the gate: skipping it would print
# "ALL CHECKS PASSED" for a check that never ran.
run_required() {
  local script_name="$1"
  local label="$2"

  if ! has_npm_script "$script_name"; then
    fail "$label — npm script '$script_name' is required but not found in package.json"
  fi

  section "$label"
  echo "  npm run $script_name"
  if npm run "$script_name"; then
    pass "$label"
  else
    fail "$label"
  fi
}

echo "Camp Scout AI — Project Verification"
echo "Project root: $ROOT"
echo ""

# Check all required scripts up front, so a missing one fails before minutes of work.
for required in typecheck lint test build; do
  has_npm_script "$required" || fail "npm script '$required' is required but not found in package.json"
done

run_required "typecheck" "Typecheck"
run_required "lint" "Lint"
# `npm test` is `jest --coverage`; the coverage floor lives in jest.config.js (coverageThreshold).
run_required "test" "Unit Tests + Coverage"
run_required "build" "Production Build"

section "Verification Complete"
echo ""
echo "✓ ALL CHECKS PASSED"
