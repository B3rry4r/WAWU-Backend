#!/usr/bin/env python3
"""deploy-test-in-sync (OPS-CI).

.github/workflows/branch-checks.yml runs the same checks on every task branch
that deploy.yml's `test` job runs after a merge. Its steps are COPIES, because
a workflow cannot call another workflow's job. A copy that drifts would let a
branch go green on checks that are not the deploy's, which is the failure
OPS-CI exists to stop. This script fails the moment the two differ.

What is compared: deploy.yml `jobs.test` against the copy, parsed with a YAML
loader (so comments, blank lines and quoting do not matter).

  * Job level, every key except those listed in JOB_KEYS_IGNORED. That covers
    `runs-on`, `services` (the Postgres service) and `env`.
  * Steps, every key of every step except `name`.

The copy splits the one deploy job into two jobs, so it is checked this way:

  suite  must equal the deploy steps without the test:netns step. Its jest step
         may carry the shard flag ` --shard=${{ matrix.shard }}/3` at the end of
         `run`; the flag is taken off before the comparison, nothing else is.
  netns  must equal the deploy steps without the tsc step and the jest step.

Every deploy step is therefore in the copy, in the same order, with the same
content. A step added to or changed in deploy.yml fails this check until the
copy follows.

The only things ignored, all of them documented here:

  1. A step's `name`.
  2. The shard flag above, on the jest step of `suite`.
  3. The last step of a copy job, when it has `id: result`: the step that
     prints the job's result as its last log line. It is the copy's own.
  4. Job keys in JOB_KEYS_IGNORED: `name`, `needs`, `strategy` and `steps`
     (the job's display name, its order, the shard matrix, and the steps
     compared separately).

Usage: python3 scripts/ci/check_deploy_in_sync.py [deploy.yml] [branch-checks.yml]
The last line printed is "IN-SYNC OK" or "IN-SYNC FAIL". Exit 0 or 1.
"""
from __future__ import annotations

import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
DEPLOY_JOB = "test"
COPY_JOBS = ("suite", "netns")
SHARD_FLAG = " --shard=${{ matrix.shard }}/3"
JOB_KEYS_IGNORED = {"name", "needs", "strategy", "steps"}


def load_jobs(path: Path) -> dict:
    try:
        doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as err:
        print(f"{path.name} is not valid YAML: {str(err).splitlines()[0]}")
        print("IN-SYNC FAIL")
        sys.exit(1)
    return doc.get("jobs") or {}


def run_of(step: dict) -> str:
    return str(step.get("run", "")).strip()


def normalise(step: dict, strip_shard: bool) -> dict:
    out = {k: v for k, v in step.items() if k != "name"}
    if strip_shard and isinstance(out.get("run"), str) and out["run"].endswith(SHARD_FLAG):
        out["run"] = out["run"][: -len(SHARD_FLAG)]
    return out


def is_netns(step: dict) -> bool:
    return "test:netns" in run_of(step)


def is_jest(step: dict) -> bool:
    return run_of(step).startswith("npx jest")


def is_tsc(step: dict) -> bool:
    return run_of(step) == "npx tsc --noEmit"


def describe(step: dict) -> str:
    text = step.get("run") or step.get("uses") or "?"
    return str(text).strip().splitlines()[0][:100]


def compare(label: str, want: list[dict], got: list[dict], problems: list[str]) -> None:
    if want == got:
        return
    for i in range(max(len(want), len(got))):
        w = want[i] if i < len(want) else None
        g = got[i] if i < len(got) else None
        if w != g:
            problems.append(
                f"{label}: step {i + 1} differs\n"
                f"    deploy.yml    : {w if w is None else describe(w)}\n"
                f"    branch-checks : {g if g is None else describe(g)}"
            )
            if w is not None and g is not None:
                for key in sorted(set(w) | set(g)):
                    if w.get(key) != g.get(key):
                        problems.append(f"    key `{key}`:\n      deploy.yml    : {w.get(key)!r}\n      branch-checks : {g.get(key)!r}")
            return


def main() -> int:
    deploy_path = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / ".github/workflows/deploy.yml"
    copy_path = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / ".github/workflows/branch-checks.yml"
    deploy_jobs = load_jobs(deploy_path)
    copy_jobs = load_jobs(copy_path)
    problems: list[str] = []

    deploy = deploy_jobs.get(DEPLOY_JOB)
    if not deploy:
        print(f"{deploy_path.name} has no job `{DEPLOY_JOB}`")
        print("IN-SYNC FAIL")
        return 1
    deploy_steps = [normalise(s, False) for s in deploy.get("steps", [])]
    deploy_job_keys = {k: v for k, v in deploy.items() if k not in JOB_KEYS_IGNORED}

    expected = {
        "suite": [s for s in deploy_steps if not is_netns(s)],
        "netns": [s for s in deploy_steps if not is_tsc(s) and not is_jest(s)],
    }

    for name in COPY_JOBS:
        job = copy_jobs.get(name)
        if not job:
            problems.append(f"{copy_path.name} has no job `{name}`")
            continue
        job_keys = {k: v for k, v in job.items() if k not in JOB_KEYS_IGNORED}
        if job_keys != deploy_job_keys:
            for key in sorted(set(job_keys) | set(deploy_job_keys)):
                if job_keys.get(key) != deploy_job_keys.get(key):
                    problems.append(
                        f"{name}: job key `{key}` differs\n"
                        f"    deploy.yml    : {deploy_job_keys.get(key)!r}\n"
                        f"    branch-checks : {job_keys.get(key)!r}"
                    )
        steps = list(job.get("steps", []))
        if steps and steps[-1].get("id") == "result":
            steps = steps[:-1]
        else:
            problems.append(f"{name}: the last step must have `id: result` (it prints the job's result)")
        got = [normalise(s, name == "suite") for s in steps]
        compare(name, expected[name], got, problems)

    if problems:
        print(f"{copy_path.name} is not a copy of the `{DEPLOY_JOB}` job in {deploy_path.name}:")
        for p in problems:
            print("  - " + p)
        print("Change both files in the same commit. Never edit this script to make the check pass.")
        print("IN-SYNC FAIL")
        return 1
    print(f"suite and netns are copies of {deploy_path.name} `{DEPLOY_JOB}`: {len(deploy_steps)} steps compared")
    print("IN-SYNC OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
