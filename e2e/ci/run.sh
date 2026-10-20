#!/usr/bin/env bash
# CI end-to-end run (pack prompt 28): every suite runs in a browser against the real React app, Django API and
# PostgreSQL. Each group starts from freshly seeded data (the verified Quran text is restored from a snapshot),
# so suites do not depend on each other's leftovers. Usage: e2e/ci/run.sh <shots-dir>
# Expects: API on :8000 (and :8001 with ADMIN_REQUIRE_MFA=1), Vite on :5174 (→8000) and :5176 (→8001), previews
# on :4173 (demo) and :4175 (live), DATABASE_URL, and backend/quran-data.sql from snapshot.sh.
set -uo pipefail
OUT="${1:?shots dir}"; mkdir -p "$OUT"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$ROOT"
PY="${PYTHON:-python}"
shell_py() { bash e2e/ci/py.sh "$1"; }
reseed() {
  (cd backend && "$PY" manage.py flush --noinput && "$PY" manage.py seed_dev >/dev/null && psql -q "$DATABASE_URL" -f quran-data.sql >/dev/null) \
    || { echo "::error title=e2e::reseed failed"; exit 1; }
}
failed=(); passed=()
run() {  # suite [base-url]
  local name="$1" t0=$SECONDS
  echo "::group::$name"
  if timeout 600 node "e2e/$name.mjs" "$OUT" "${2:-http://localhost:5174/}" 2>&1 | tee "$OUT/$name.log"; then
    grep -q "ALL PASSED" "$OUT/$name.log" && { passed+=("$name"); echo "::endgroup::"; return; }
  fi
  failed+=("$name")
  echo "::endgroup::"
  echo "::error title=e2e $name::$(grep -E '^FAIL' "$OUT/$name.log" | head -3 | tr '\n' ' ' | cut -c1-600) (screenshots in the e2e-shots artifact)"
  echo "   ($((SECONDS - t0)) s)"
}
export PYTHON="$PY"

# 1. Student signup/onboarding/session restore, verified Quran reader, recording → submission → feedback, parent (no audio), progress.
reseed; run live; run quran; run reading; run quran-audio; run loop; shell_py past_booking.py; shell_py attendance.py; run parent; run progress
# 2. Teacher slot → booking → cancel/reschedule → attendance; lessons and quiz with server + teacher grading;
#    a live session joined through the teacher's meeting link.
reseed; PAST_CMD="bash e2e/ci/py.sh past_booking.py" run schedule; run learn
reseed; SOON_CMD="bash e2e/ci/py.sh soon_booking.py" run live-session
# 3. Spaced repetition and Today plan; notifications inbox.
reseed; DUE_CMD="bash e2e/ci/py.sh due_reviews.py" run reviews
reseed; run inbox
# 3b. Student mistakes: teacher records a point, student sees and opens it, follow-up task, resolve, parent summary.
reseed; run mistakes
# 3c. Parent login: setup link → «تسجيل دخول ولي الأمر» → parent portal with two children → logout.
reseed; SETUP_CMD="bash e2e/ci/py.sh parent_setup.py" run parent-login
# 4. Admin: real sign-in with enforced two-step verification (second server, which also has a test ayah-audio
#    source for quran-audio), then persistent edits.
reseed; MFA_ENFORCED=1 RESET_CMD="bash e2e/ci/py.sh mfa_reset.py" run admin http://localhost:5176/
for s in admin-people admin-scheduling admin-content admin-settings teacher-content; do reseed; run "$s"; done
reseed; MANY_CMD="bash e2e/ci/py.sh many_students.py" run admin-bulk
reseed; run admin-ops
reseed; run circle-members
# 5. PWA: manifest, installability, offline shell, no API data in caches (preview builds); an update published
#    during a recording waits until the recording is submitted.
reseed; run pwa http://localhost:4173/
reseed; run push http://localhost:4175/
reseed; NEW_VERSION_CMD="echo '// e2e update' >> ${LIVE_DIST:-/tmp/dist-live}/sw.js" run pwa-update http://localhost:4175/

{
  echo "## End-to-end suites"
  echo "Passed (${#passed[@]}): ${passed[*]:-none}"
  echo; echo "Failed (${#failed[@]}): ${failed[*]:-none}"
} | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
[ ${#failed[@]} -eq 0 ]
