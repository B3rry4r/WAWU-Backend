#!/usr/bin/env bash
# The V3 check a pull request gets (.github/workflows/protected-routes.yml).
#
#   scripts/protected-routes/ci-check.sh <base-sha> <pr-sha> <relock-approved: 0|1>
#
# Run from a checkout of the BASE branch, never of the pull request: this file,
# run.sh, lock-diff.py and the suite under test/protected-routes and
# src/protected-routes all come from the base, so nothing the pull request
# changes can loosen the checker or the lock it is held to. The pull request
# contributes only the code under test (<pr-sha>, which must exist in this
# repository's object store; the workflow fetches it).
#
# Decision:
#   - base has no suite yet (the pull request that introduces it): the pull
#     request's own checker and lock, said so in the summary;
#   - the pull request changes the lock or any checker file, and the owner's
#     relock-approved label was applied AFTER its latest push (the workflow
#     decides that and passes 1): the pull request's own checker and lock;
#   - otherwise: the base's checker and the base's lock. A pull request that
#     changes the lock without that approval is therefore checked against the
#     lock it tried to change, and fails if its code no longer matches it.
#
# Needs the same environment as run.sh (DATABASE_URL, WAWU_ID_BASE_URL, the
# admin secrets). Exit code is the suite's.
set -euo pipefail

BASE_SHA="$1"
PR_SHA="$2"
APPROVED="${3:-0}"
REPO="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/protected-ci.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# Everything said is printed, and appended to the job summary in CI.
say() {
  printf '%s\n' "$*"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf '%s\n' "$*" >> "$GITHUB_STEP_SUMMARY"; fi
}

if git -C "$REPO" cat-file -e "$BASE_SHA:scripts/protected-routes/run.sh" 2>/dev/null; then
  BASE_HAS_SUITE=1
else
  BASE_HAS_SUITE=0
fi

if [ "$BASE_HAS_SUITE" = 1 ]; then
  git -C "$REPO" show "$BASE_SHA:scripts/protected-routes/lock-diff.py" > "$TMP/lock-diff.py"
  set +e
  (cd "$REPO" && python3 "$TMP/lock-diff.py" "$BASE_SHA" "$PR_SHA") > "$TMP/diff.md"
  DIFF=$?
  set -e
  say "$(cat "$TMP/diff.md")"
else
  DIFF=2
fi

if [ "$DIFF" = 2 ]; then
  CHECKER=pr
  say "The base has no protected route suite yet: checked with this pull request's own suite and lock."
elif [ "$DIFF" = 1 ] && [ "$APPROVED" = 1 ]; then
  CHECKER=pr
  say "The owner approved this lock change after the latest push (relock-approved): checked with this pull request's own suite and lock."
elif [ "$DIFF" = 1 ]; then
  CHECKER=base
  say "**This pull request changes the lock or the checker without the owner's approval for its latest push.** It is checked against the base's suite and lock, unchanged."
else
  CHECKER=base
  say "Checked with the base's suite and lock."
fi

if [ "$CHECKER" = base ]; then
  # run.sh as it is on the base, with the base's suite and lock overlaid on
  # the pull request's code.
  git -C "$REPO" show "$BASE_SHA:scripts/protected-routes/run.sh" > "$REPO/.protected-ci-run.sh"
  LOCK="$BASE_SHA"
else
  git -C "$REPO" show "$PR_SHA:scripts/protected-routes/run.sh" > "$REPO/.protected-ci-run.sh"
  LOCK="$PR_SHA"
fi
trap 'rm -rf "$TMP" "$REPO/.protected-ci-run.sh"' EXIT
PROTECTED_LOCK_REF="$LOCK" bash "$REPO/.protected-ci-run.sh" --fresh "$PR_SHA"
