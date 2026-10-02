#!/usr/bin/env bash
# The V3 check a pull request gets (.github/workflows/protected-routes.yml).
#
#   scripts/protected-routes/ci-check.sh <base-sha> <pr-sha> <relock-approved: 0|1>
#
# Run from a checkout of the BASE branch, never of the pull request: this file,
# run.sh, lock-diff.py and the suite under test/protected-routes and
# src/protected-routes all come from the base, so an accidental or casual edit
# to the checker or the lock in a pull request does not change what it is
# held to. The pull request contributes the code under test (<pr-sha>, which
# must exist in this repository's object store; the workflow fetches it).
# That code still runs (seed, prisma config, the app), so deliberate tampering
# is out of scope here and caught by review (README, "Protected route suite").
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

# What the pull request itself changed is measured from where it branched
# off, not from the base's tip, so commits that landed on the base since are
# not attributed to it.
MERGE_BASE="$(git -C "$REPO" merge-base "$BASE_SHA" "$PR_SHA")"

if [ "$BASE_HAS_SUITE" = 1 ]; then
  git -C "$REPO" show "$BASE_SHA:scripts/protected-routes/lock-diff.py" > "$TMP/lock-diff.py"
  set +e
  (cd "$REPO" && python3 "$TMP/lock-diff.py" "$MERGE_BASE" "$PR_SHA") > "$TMP/diff.md"
  DIFF=$?
  set -e
  say "$(cat "$TMP/diff.md")"

  # Cheap tripwire for code OUTSIDE the checker that reaches into it: a seed
  # script, the prisma config or app code that rewrites or patches the suite.
  # Only lines the pull request adds are read, Markdown is skipped (it does
  # not run), and the checker's own files are covered by lock-diff above. It
  # stops accidental and casual edits; deliberate obfuscation is caught by
  # review, not here (README, "Protected route suite").
  git -C "$REPO" diff -U0 "$MERGE_BASE" "$PR_SHA" -- . \
    ':(exclude)src/protected-routes' ':(exclude)test/protected-routes' \
    ':(exclude)scripts/protected-routes' ':(exclude).github/workflows/protected-routes.yml' \
    ':(exclude).pipeline/protected-registry.json' ':(exclude)*.md' > "$TMP/outside.diff"
  python3 - "$TMP/outside.diff" > "$TMP/reach.txt" <<'PY'
import re, sys
pattern = re.compile(r'test/protected-routes|src/protected-routes|compareShape|protected-registry')
current = None
for line in open(sys.argv[1], encoding='utf-8', errors='replace'):
    if line.startswith('+++ '):
        current = line[6:].strip() if line.startswith('+++ b/') else line[4:].strip()
    elif line.startswith('+') and pattern.search(line):
        print(f'- `{current}`: `{line[1:].strip()[:160]}`')
PY
  if [ -s "$TMP/reach.txt" ]; then
    say "**Code outside the protected route checker refers to it.** Only the checker's own files may name the suite, its shape comparison or the registry:"
    say "$(cat "$TMP/reach.txt")"
    if [ "$APPROVED" != 1 ]; then
      say "Refused. If this is intended, the owner reviews it and applies relock-approved."
      exit 1
    fi
  fi
else
  DIFF=2
fi

if [ "$BASE_HAS_SUITE" = 0 ]; then
  CHECKER=pr
  say "The base has no protected route suite yet: checked with this pull request's own suite and lock."
elif [ "$DIFF" = 2 ]; then
  # The pull request branched off before the suite existed, so it cannot
  # have touched it: the base's checker and lock.
  CHECKER=base
  say "This pull request branched off before the suite existed: checked with the base's suite and lock."
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
