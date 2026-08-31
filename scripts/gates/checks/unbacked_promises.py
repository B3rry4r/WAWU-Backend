"""A promise nothing implements is worse than a wrong number.

A wrong figure is an error someone spots. A guarantee with no mechanism behind
it is a commitment to a customer that nobody discovers is empty until it is
relied on -- and by then it has been relied on.

This repo has shipped two:

  * "changing it takes a 24-hour security hold"   -- no such mechanism existed
  * "We'll notify you when you're verified"       -- no push, no email, nothing

Both read as ordinary product copy. Both passed every structural gate here,
because they are *semantic* defects: the code is well-formed, the widget tree is
correct, the string is just not true. Nothing in this harness looked at what the
words claimed until a human did.

So this gate reads the claims.

Two tiers, because a noisy gate gets switched off and a switched-off gate is
worse than none -- it reads as coverage:

  Tier A -- a promise of a FUTURE ACT BY US ("we will notify/email/call/text
            you", "you will receive a ..."). Something must deliver it. These
            fire on their own.

  Tier B -- a duration, deadline or guarantee ("within 24 hours", "1-2 business
            days", "instantly", "guaranteed"). Ambiguous alone: "settles in
            T+3" may be a fact about the exchange, not a promise by us. These
            fire only when they sit near first-person framing (we/our/you'll),
            which is what turns a description into a commitment.

## The release valve

A promise is legitimate when something implements it. Say what, on or near the
line:

    // MECHANISM: push via NotificationService.sendKycDecision (backend BR-4)
    Text("We'll email you when verification finishes")

or cite a ruling that settled the copy:

    // R-33: canvas copy kept verbatim, mechanism confirmed 2026-08
"""

from __future__ import annotations

import re
from typing import Iterator

from run import Context, Finding

NAME = "unbacked_promises"

# A promise of a future act by us, TO THE USER. Two things both have to hold.
#
# The actor matters: "we'll notify you" is a commitment; "your bank may notify
# you" is not ours to keep.
#
# The recipient matters just as much, and missing that made this gate's first
# run cry wolf on statutory text. "we will notify the Commission within 72
# hours, as Section 40 of the NDPA requires" is a legal duty owed to a
# regulator, correctly written down in a policy document -- it is not a product
# promise, nothing in the app implements it, and nothing in the app should.
# Flagging it teaches people to ignore this gate, which is the one outcome that
# guarantees the next real promise ships.
#
# So the promise must land on the user: `you` (or `your`) has to appear as the
# recipient, not merely somewhere in the sentence.
TIER_A = re.compile(
    r"\b(?:we(?:'|’)?ll|we\s+will|you(?:'|’)?ll\s+(?:receive|get)|"
    r"we(?:'|’)?(?:ve|re)\s+going\s+to)\s+"
    r"(?:\w+\s+){0,3}?"
    r"(notify|email|e-mail|text|call|message|alert|remind|send)\b"
    r"(?:\s+\w+){0,2}?\s+\byou(?:r)?\b",
    re.I,
)

# Durations, deadlines and guarantees. Alone these are often plain fact.
TIER_B = re.compile(
    r"\b(?:within\s+\d+\s*(?:hours?|days?|minutes?|business\s+days?)"
    r"|\d+\s*[-–]\s*\d+\s*business\s+days?"
    r"|in\s+(?:under|less\s+than)\s+\d+\s*(?:hours?|minutes?|days?)"
    r"|\d+\s*-\s*hour\s+(?:hold|window|delay)"
    r"|instantly|immediately|guaranteed?|no\s+(?:hidden|extra)\s+(?:charges?|fees?))\b",
    re.I,
)

# First-person framing near a Tier B phrase is what makes it a commitment.
FIRST_PERSON = re.compile(r"\b(?:we|we(?:'|’)?ll|our|us|you(?:'|’)?ll)\b", re.I)

# The release valve.
BACKED = re.compile(r"\bMECHANISM\s*:|\bR-\d+\b|\bBR-\d+\b", re.I)

STRING_LIT = re.compile(r"""(['"])(?P<body>(?:\\.|(?!\1)[^\\])*)\1""")

CONTEXT = 3  # lines either side searched for the valve


def _backed_near(ctx: Context, lines: list[str], idx: int) -> bool:
    lo = max(0, idx - CONTEXT)
    hi = min(len(lines), idx + CONTEXT + 1)
    return any(BACKED.search(lines[i]) for i in range(lo, hi))


def run(ctx: Context) -> Iterator[Finding]:
    for path in ctx.source_files("source"):
        if ctx.is_test(path):
            continue
        rel = ctx.rel(path)
        lines = [ln for _, ln in ctx.lines(path)]

        for idx, line in enumerate(lines):
            stripped = line.strip()
            if stripped.startswith(("//", "///", "#", "*")):
                continue  # a comment discussing copy is not shipped copy

            for m in STRING_LIT.finditer(line):
                body = m.group("body")
                if len(body) < 12:
                    continue

                hit = TIER_A.search(body)
                tier = "A"
                if not hit:
                    b = TIER_B.search(body)
                    # Tier B needs first-person framing to count as a promise.
                    if b and FIRST_PERSON.search(body):
                        hit, tier = b, "B"

                if not hit:
                    continue
                if _backed_near(ctx, lines, idx):
                    continue

                phrase = hit.group(0).strip()
                yield Finding(
                    gate=NAME,
                    path=rel,
                    line=idx + 1,
                    message=(
                        f"copy promises '{phrase}' with nothing named to deliver it - "
                        f"say what implements it (// MECHANISM: ...) or cite a ruling, "
                        f"or do not promise it"
                    ),
                    evidence=body[:160],
                    severity="fail" if tier == "A" else "warn",
                )
