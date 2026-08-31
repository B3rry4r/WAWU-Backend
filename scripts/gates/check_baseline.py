#!/usr/bin/env python3
"""The baseline is where accepted violations live. Guard it.

An accepted violation with no owner and no reason is a stub with better
manners: it silences a gate and records nothing anyone can act on. Six months
later nobody knows whether it was a deliberate trade-off or an agent trying to
get to green.

So: every entry in baseline.json needs a real owner and a real reason, and this
runs in CI alongside the gates themselves.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
BASELINE = HERE / "baseline.json"

# NOTE: no empty string in here. `"anything".startswith("")` is True, so an ""
# entry makes every value look like a placeholder and the check fails on
# perfectly good baselines. Emptiness is handled by the length tests below.
PLACEHOLDERS = ("unset", "todo", "tbd", "n/a", "na", "?", "none", "-")
MIN_REASON = 15


def _is_placeholder(value: str, min_len: int) -> bool:
    """True when a field was never actually filled in.

    Deliberately NOT a bare `startswith`. A real reason often *begins with the
    word it is explaining* -- "TODO(wave-2) note on the seed script's own
    transaction rows, describing a seed-data nicety..." is two hundred
    characters of genuine justification for a `deferrals` finding, and a
    startswith test threw it out alongside the empty entries. Getting rejected
    for explaining the thing you were asked to explain is how people learn to
    stop writing reasons.

    So a value is a placeholder when it is *only* a placeholder: the whole
    string is one of the stock words (give or take punctuation), or it is too
    short to act on. Anything long enough to be actionable is taken at face
    value -- this guard checks that someone wrote something, not whether it is
    a good argument. That judgement belongs to a human reading the diff.
    """
    stripped = value.strip().lower().strip(".:;- ")
    if not stripped:
        return True

    # "unset" is scaffolding and nothing else. `--accept` writes
    # "UNSET -- put a name here" / "UNSET -- say why this is acceptable...",
    # and no genuine sentence has ever opened with it, so a prefix test is
    # safe here and is the single most important case to catch.
    if stripped.startswith("unset"):
        return True

    # The rest ("todo", "tbd", "n/a", "none", "?") DO legitimately open real
    # prose -- a reason explaining a `deferrals` finding naturally starts
    # "TODO(wave-2) note on the seed script...". So they only count when the
    # whole value is that word and nothing more.
    if stripped in PLACEHOLDERS:
        return True

    return len(value.strip()) < min_len


def main() -> int:
    if not BASELINE.exists():
        print("no baseline.json - nothing accepted, nothing to check")
        return 0

    try:
        data = json.loads(BASELINE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"baseline.json is unreadable: {exc}", file=sys.stderr)
        return 1

    accepted = data.get("accepted", {})
    bad: list[str] = []

    for key, entry in accepted.items():
        owner = str(entry.get("owner", "")).strip()
        reason = str(entry.get("reason", "")).strip()
        where = entry.get("where", "?")

        if _is_placeholder(owner, 2):
            bad.append(f"{key} ({where}): no owner")
        if _is_placeholder(reason, MIN_REASON):
            bad.append(f"{key} ({where}): reason is missing or too thin to act on")

    print(f"baseline entries: {len(accepted)}")
    if bad:
        print("\nUnexplained accepted violations:\n", file=sys.stderr)
        for line in bad:
            print(f"  {line}", file=sys.stderr)
        print(
            f"\n{len(bad)} problem(s). Give each entry an owner and a reason, "
            "or delete the entry and fix the finding.",
            file=sys.stderr,
        )
        return 1

    print("every accepted violation has an owner and a reason")
    return 0


if __name__ == "__main__":
    sys.exit(main())
