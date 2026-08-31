#!/usr/bin/env python3
"""Executable gates. A law that is not an exit code is not a law.

Usage:
    python3 scripts/gates/run.py                 # run every enabled gate
    python3 scripts/gates/run.py --gate deferrals
    python3 scripts/gates/run.py --json
    python3 scripts/gates/run.py --accept        # write current findings to baseline.json

Exit codes:
    0  no un-baselined FAIL findings
    1  at least one un-baselined FAIL finding
    2  the harness itself is broken (bad config, missing check)

Baseline
--------
`baseline.json` holds findings you have explicitly accepted. A baselined finding
prints as ACCEPTED and does not fail the build. This is what "deferred-by-user"
means here: a line in a file, with an owner and a reason, that a machine reads --
never a sentence in a report that nobody re-reads.

New findings are never auto-baselined. `--accept` is a deliberate act.
"""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import importlib
import json
import os
import sys
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Iterable, Iterator

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
CONFIG_PATH = HERE / "gates.config.json"
BASELINE_PATH = HERE / "baseline.json"

FAIL = "fail"
WARN = "warn"


@dataclass
class Finding:
    """One machine-checkable defect. `key` must be stable across unrelated edits."""

    gate: str
    message: str
    path: str = ""
    line: int = 0
    evidence: str = ""
    severity: str = FAIL
    # Identity for baselining. Deliberately excludes the line number so that
    # inserting a line above a known finding does not resurrect it as "new".
    def key(self) -> str:
        raw = f"{self.gate}\x00{self.path}\x00{self.evidence.strip()[:200]}\x00{self.message}"
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]

    def where(self) -> str:
        if not self.path:
            return "-"
        return f"{self.path}:{self.line}" if self.line else self.path


# Every path any gate actually opened. A harness that cannot say what it looked
# at cannot be believed when it says it found nothing -- a glob that matches no
# files prints GATES PASSED and exits 0, which is the most dangerous output this
# program has. See the zero-file check at the end of main().
SCANNED: set = set()


@dataclass
class Context:
    """What every check gets. Keeps checks free of path/config plumbing."""

    repo: Path
    config: dict
    gate_config: dict = field(default_factory=dict)

    # ---- file access -------------------------------------------------

    def source_files(self, kind: str = "source") -> list[Path]:
        """Files in a named group from config['files'], excluding config['exclude']."""
        groups = self.config.get("files", {})
        patterns = groups.get(kind, [])
        excludes = groups.get("exclude", [])
        out: list[Path] = []
        for pattern in patterns:
            for p in sorted(self.repo.glob(pattern)):
                if not p.is_file():
                    continue
                rel = p.relative_to(self.repo).as_posix()
                if any(fnmatch.fnmatch(rel, ex) for ex in excludes):
                    continue
                out.append(p)
        # dedupe, preserve order
        seen: set[Path] = set()
        uniq = []
        for p in out:
            if p not in seen:
                seen.add(p)
                uniq.append(p)
        SCANNED.update(uniq)
        return uniq

    def rel(self, p: Path) -> str:
        try:
            return p.relative_to(self.repo).as_posix()
        except ValueError:
            return p.as_posix()

    def lines(self, p: Path) -> Iterator[tuple[int, str]]:
        try:
            text = p.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return
        for i, line in enumerate(text.splitlines(), start=1):
            yield i, line

    def is_test(self, p: Path) -> bool:
        rel = self.rel(p)
        return any(fnmatch.fnmatch(rel, pat) for pat in self.config.get("files", {}).get("test", []))


# ---------------------------------------------------------------------------


def load_json(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"harness: cannot read {path}: {exc}", file=sys.stderr)
        sys.exit(2)


def discover(config: dict, only: str | None) -> list[tuple[str, dict]]:
    gates = config.get("gates", {})
    if only:
        if only not in gates:
            print(f"harness: unknown gate {only!r}. known: {', '.join(sorted(gates))}", file=sys.stderr)
            sys.exit(2)
        return [(only, gates[only])]
    return [(name, cfg) for name, cfg in gates.items() if cfg.get("enabled", True)]


def run_gate(name: str, gate_cfg: dict, config: dict) -> list[Finding]:
    try:
        mod = importlib.import_module(f"checks.{name}")
    except ImportError as exc:
        print(f"harness: gate {name!r} has no implementation in checks/: {exc}", file=sys.stderr)
        sys.exit(2)
    ctx = Context(repo=REPO, config=config, gate_config=gate_cfg)
    findings = list(mod.run(ctx))
    # A gate may downgrade itself to warn-only during adoption.
    if gate_cfg.get("severity") == WARN:
        for f in findings:
            f.severity = WARN
    return findings


def main() -> int:
    ap = argparse.ArgumentParser(description="Run the repo's executable gates.")
    ap.add_argument("--gate", help="run one gate by name")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    ap.add_argument("--accept", action="store_true", help="baseline every current finding")
    ap.add_argument("--quiet", action="store_true", help="only print failures")
    args = ap.parse_args()

    sys.path.insert(0, str(HERE))
    config = load_json(CONFIG_PATH, None)
    if config is None:
        print(f"harness: no config at {CONFIG_PATH}", file=sys.stderr)
        return 2

    baseline = load_json(BASELINE_PATH, {"accepted": {}})
    accepted: dict = baseline.get("accepted", {})

    all_findings: list[Finding] = []
    for name, gate_cfg in discover(config, args.gate):
        all_findings.extend(run_gate(name, gate_cfg, config))

    if args.accept:
        for f in all_findings:
            accepted.setdefault(
                f.key(),
                {
                    "gate": f.gate,
                    "where": f.where(),
                    "message": f.message,
                    "evidence": f.evidence.strip()[:200],
                    "owner": "UNSET -- put a name here",
                    "reason": "UNSET -- say why this is acceptable, or delete this entry and fix it",
                },
            )
        BASELINE_PATH.write_text(
            json.dumps({"accepted": accepted}, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        print(f"baselined {len(all_findings)} finding(s) into {CONFIG_PATH.parent.name}/baseline.json")
        print("Every entry needs an owner and a reason. An unexplained baseline is a stub with better manners.")
        return 0

    new = [f for f in all_findings if f.key() not in accepted]
    old = [f for f in all_findings if f.key() in accepted]
    failures = [f for f in new if f.severity == FAIL]

    if args.json:
        print(
            json.dumps(
                {
                    "failures": [asdict(f) | {"key": f.key()} for f in failures],
                    "warnings": [asdict(f) | {"key": f.key()} for f in new if f.severity == WARN],
                    "accepted": [asdict(f) | {"key": f.key()} for f in old],
                },
                indent=2,
            )
        )
        return 1 if failures else 0

    by_gate: dict[str, list[Finding]] = {}
    for f in new:
        by_gate.setdefault(f.gate, []).append(f)

    for gate in sorted(by_gate):
        items = by_gate[gate]
        n_fail = sum(1 for f in items if f.severity == FAIL)
        head = f"{gate}  ({n_fail} fail, {len(items) - n_fail} warn)"
        print(f"\n\033[1m{head}\033[0m")
        for f in items:
            tag = "\033[31mFAIL\033[0m" if f.severity == FAIL else "\033[33mwarn\033[0m"
            print(f"  {tag}  {f.where()}")
            print(f"        {f.message}")
            if f.evidence:
                print(f"        \033[2m{f.evidence.strip()[:160]}\033[0m")

    ran = [n for n, _ in discover(config, args.gate)]
    print()
    print("─" * 72)
    print(f"gates run: {len(ran)}   files scanned: {len(SCANNED)}   "
          f"findings: {len(failures)} fail, {len(new) - len(failures)} warn, "
          f"{len(old)} accepted")

    if not SCANNED:
        # Zero files is never a clean bill of health, it is a broken config --
        # almost always a `files.source` glob pointing at a directory layout this
        # repo does not have. Passing here would hand back a green light that
        # means nothing, which is worse than no gate at all.
        print("\033[31mGATES INCONCLUSIVE.\033[0m No files matched `files.source` in "
              f"{CONFIG_PATH.name} -- the globs do not fit this repo's layout.")
        print("Nothing was examined, so nothing was cleared. Fix the globs and re-run.")
        return 2

    if failures:
        print("\033[31mGATES FAILED.\033[0m Fix them, or `--accept` them with an owner and a reason.")
    else:
        print("\033[32mGATES PASSED.\033[0m")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
