"""Never invent a wire shape.

A response shape declared anywhere except the data layer is a shape somebody
guessed. That is how `undefined.map` is born: a client typed `{items}` against
an endpoint that returns a bare array, and every test that mocked the client's
own type passed.

Wire shapes belong in one place, generated from or checked against the API
contract. Screens import them; screens never declare them.
"""

from __future__ import annotations

import fnmatch
import re
from typing import Iterator

from run import Context, Finding

NAME = "wire_types"

# Dart: `factory Foo.fromJson(` / `Foo.fromJson(Map<String, dynamic>`
DART_FROMJSON = re.compile(r"\b(?:factory\s+)?(\w+)\.fromJson\s*\(\s*(?:Map|dynamic|final)")
# Dart: `Map<String, dynamic> toJson()`
DART_TOJSON = re.compile(r"Map<String,\s*dynamic>\s+toJson\s*\(")
# TS: `interface FooResponse {` / `type FooDto = {`
TS_WIRE = re.compile(r"\b(?:interface|type)\s+(\w*(?:Response|Dto|DTO|Payload|ApiResult)\w*)\b")


def run(ctx: Context) -> Iterator[Finding]:
    data_layer = ctx.gate_config.get("data_layer", [])
    if not data_layer:
        return

    for path in ctx.source_files("source"):
        if ctx.is_test(path):
            continue
        rel = ctx.rel(path)
        if any(fnmatch.fnmatch(rel, pat) for pat in data_layer):
            continue

        for lineno, line in ctx.lines(path):
            stripped = line.strip()
            if stripped.startswith(("//", "///", "#", "*")):
                continue

            m = DART_FROMJSON.search(line)
            if m:
                yield Finding(
                    gate=NAME,
                    path=rel,
                    line=lineno,
                    message=(
                        f"wire shape '{m.group(1)}' parsed outside the data layer - "
                        f"move it into the data layer and import it"
                    ),
                    evidence=line,
                )
                continue
            if DART_TOJSON.search(line):
                yield Finding(
                    gate=NAME,
                    path=rel,
                    line=lineno,
                    message="wire serialisation declared outside the data layer",
                    evidence=line,
                )
                continue
            m = TS_WIRE.search(line)
            if m:
                yield Finding(
                    gate=NAME,
                    path=rel,
                    line=lineno,
                    message=f"response shape '{m.group(1)}' hand-declared outside the data layer",
                    evidence=line,
                )
