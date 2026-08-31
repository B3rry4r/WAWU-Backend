"""Open tracked work is a build failure, not a backlog.

The pipeline skills already say an unresolved `stubs.json` entry or an open
`ui-align-tasks.json` task is a HALT CONDITION. On the run that motivated this
harness, 12 of 34 stubs were unresolved and 19 of 80 align tasks were open, and
the pipeline reported done anyway -- because a halt condition written in a
markdown file is evaluated by a tired model that wants to finish.

Here it is an exit code.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterator

from run import Context, Finding

NAME = "pipeline_open_items"

# artifact -> (field to read, values that count as CLOSED)
CLOSED_VALUES = {
    "stubs.json": ("resolution", {"implemented", "deferred-by-user", "not-a-stub"}),
    "ui-align-tasks.json": ("status", {"done", "deferred-by-user"}),
    "conflicts.json": ("status", {"resolved"}),
}


def _items(blob: Any) -> list[dict]:
    if isinstance(blob, list):
        return [i for i in blob if isinstance(i, dict)]
    if isinstance(blob, dict):
        for value in blob.values():
            if isinstance(value, list) and value and isinstance(value[0], dict):
                return value
    return []


def _describe(item: dict) -> str:
    for key in ("id", "title", "description", "summary", "file", "path", "screen", "name"):
        if item.get(key):
            return f"{key}={item[key]}"
    return json.dumps(item)[:120]


def run(ctx: Context) -> Iterator[Finding]:
    roots = ctx.gate_config.get("pipeline_dirs", [])
    if not roots:
        return

    found_any = False
    for root in roots:
        base = (ctx.repo / root).resolve()
        if not base.is_dir():
            continue
        found_any = True
        for filename, (field, closed) in CLOSED_VALUES.items():
            path: Path = base / filename
            if not path.exists():
                continue
            rel = ctx.rel(path) if str(path).startswith(str(ctx.repo)) else str(path)
            try:
                blob = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                yield Finding(
                    gate=NAME, path=rel,
                    message=f"pipeline artifact is unreadable: {exc}",
                )
                continue

            items = _items(blob)
            if filename == "conflicts.json" and not items and blob:
                # conflicts.json is expected to be empty; a non-empty unstructured
                # blob is still a conflict.
                if isinstance(blob, list) and blob:
                    yield Finding(gate=NAME, path=rel,
                                  message=f"{len(blob)} unresolved conflict(s) block the registry")
                continue

            open_items = [i for i in items if str(i.get(field, "")).lower() not in closed]
            for item in open_items:
                yield Finding(
                    gate=NAME,
                    path=rel,
                    message=(
                        f"{filename}: {field}="
                        f"{item.get(field, '<missing>')!r} - tracked work is still open"
                    ),
                    evidence=_describe(item),
                )

    if not found_any and ctx.gate_config.get("require_pipeline", False):
        yield Finding(
            gate=NAME,
            message=f"no pipeline artifacts found in any of: {', '.join(roots)}",
        )
