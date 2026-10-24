#!/usr/bin/env python3
"""deploy-test-in-sync (OPS-CI, reshaped by DEPLOY-FAST).

.github/workflows/branch-checks.yml runs the same checks on every task branch
that deploy.yml runs after a merge. Both files now run them the same way: two
jobs, `suite` (jest in 3 shards, each with its own Postgres) and `netns`. The
jobs of deploy.yml are COPIES of the jobs of branch-checks.yml, because a
workflow cannot call another workflow's job. A copy that drifts would let a
branch go green on checks that are not the deploy's, which is the failure
OPS-CI exists to stop; a deploy that tests less than Branch checks would let a
merge reach the droplet on weaker checks. This script fails the moment the two
differ.

What is compared, for `suite` and for `netns`: deploy.yml `jobs.<job>` against
branch-checks.yml `jobs.<job>`, parsed with a YAML loader (so comments, blank
lines and quoting do not matter).

  * Job level, every key except those listed in JOB_KEYS_IGNORED. That covers
    `runs-on`, `services` (the Postgres service), `env` and `strategy` (the
    shard matrix).
  * Steps, every key of every step except `name`, in the same order. The jest
    step carries `--shard=${{ matrix.shard }}/N` on both sides.

The sharding is checked on its own, on each side: the matrix is exactly the
shards 1 to N, and the jest step ends with `--shard=${{ matrix.shard }}/N` for
the same N. A shard that is never run (a matrix of 1 and 2 with /3) would drop
a third of the suite without any step differing; this catches it. The suite
must still run `npx tsc --noEmit` and `npx jest`, and netns `test:netns`.

What is checked in deploy.yml only (the decision to skip the tests, and what
the deploy waits for):

  * `suite` and `netns` wait for `decide` and carry the exact condition
    `needs.decide.outputs.skip_tests != 'true'`.
  * `deploy` waits for `decide`, `suite` and `netns`, and its condition names
    the results of the three, `inputs.dry_run` and `refs/heads/main`.
  * `concurrency` keeps the group `deploy-hub-api` and never cancels a run
    that is in progress.

The only things ignored, all of them documented here:

  1. A step's `name`.
  2. The last step of a job, when it has `id: result`: the step that prints the
     job's result as its last log line. It belongs to Branch checks.
  3. Job keys in JOB_KEYS_IGNORED: `name`, `needs` and `if` (the job's display
     name, its order and its condition, checked for deploy.yml as above) and
     `steps` (compared separately).

The check proves itself on every run (SELF_TESTS): it applies changes that
must be caught (a step dropped or changed on one side only, a shard dropped, a
condition removed, ...) to the parsed files in memory and fails unless each is
reported. `--self-test` runs only that.

Usage: python3 scripts/ci/check_deploy_in_sync.py [deploy.yml] [branch-checks.yml]
       python3 scripts/ci/check_deploy_in_sync.py --self-test
The last line printed is "IN-SYNC OK" or "IN-SYNC FAIL". Exit 0 or 1.
"""
from __future__ import annotations

import copy
import re
import sys
from pathlib import Path
from typing import Callable

import yaml

ROOT = Path(__file__).resolve().parents[2]
COPY_JOBS = ("suite", "netns")
JOB_KEYS_IGNORED = {"name", "needs", "if", "steps"}
SKIP_IF = "needs.decide.outputs.skip_tests != 'true'"
DEPLOY_IF_PARTS = (
    "refs/heads/main",
    "inputs.dry_run",
    "needs.decide.result",
    "needs.decide.outputs.skip_tests",
    "needs.suite.result",
    "needs.netns.result",
)
DEPLOY_NEEDS = {"decide", "suite", "netns"}
SHARD_FLAG_RE = re.compile(r" --shard=\$\{\{ matrix\.shard \}\}/(\d+)$")

Jobs = dict


def load_jobs(path: Path) -> dict:
    try:
        doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as err:
        print(f"{path.name} is not valid YAML: {str(err).splitlines()[0]}")
        print("IN-SYNC FAIL")
        sys.exit(1)
    return doc


def run_of(step: dict) -> str:
    return str(step.get("run", "")).strip()


def normalise(step: dict) -> dict:
    return {k: v for k, v in step.items() if k != "name"}


def is_netns(step: dict) -> bool:
    return "test:netns" in run_of(step)


def is_jest(step: dict) -> bool:
    return run_of(step).startswith("npx jest")


def is_tsc(step: dict) -> bool:
    return run_of(step) == "npx tsc --noEmit"


def describe(step: dict) -> str:
    text = step.get("run") or step.get("uses") or "?"
    return str(text).strip().splitlines()[0][:100]


def as_list(value) -> list:
    if value is None:
        return []
    return list(value) if isinstance(value, (list, tuple)) else [value]


def job_steps(job: dict) -> list[dict]:
    """The job's steps without the copy's own trailing `id: result` step."""
    steps = list(job.get("steps", []))
    if steps and steps[-1].get("id") == "result":
        steps = steps[:-1]
    return steps


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
                        problems.append(
                            f"    key `{key}`:\n      deploy.yml    : {w.get(key)!r}\n      branch-checks : {g.get(key)!r}"
                        )
            return


def check_sharding(side: str, name: str, job: dict, problems: list[str]) -> None:
    """The shards of a `suite` job are 1..N and its jest step runs --shard=x/N."""
    steps = job_steps(job)
    jest = [s for s in steps if is_jest(s)]
    if len(jest) != 1:
        problems.append(f"{side} {name}: expected exactly one `npx jest` step, found {len(jest)}")
        return
    m = SHARD_FLAG_RE.search(run_of(jest[0]))
    if not m:
        problems.append(f"{side} {name}: the jest step does not end with ` --shard=${{{{ matrix.shard }}}}/N`")
        return
    count = int(m.group(1))
    matrix = ((job.get("strategy") or {}).get("matrix") or {}).get("shard")
    if matrix != list(range(1, count + 1)):
        problems.append(
            f"{side} {name}: the jest step runs shard x/{count} but the matrix is {matrix!r}, "
            f"not the shards 1 to {count}: a shard would never run"
        )
    if "--runInBand" not in run_of(jest[0]):
        problems.append(f"{side} {name}: the jest step must run --runInBand (the suite is not parallel-safe)")


def find_problems(deploy_doc: dict, copy_doc: dict, deploy_name: str = "deploy.yml",
                  copy_name: str = "branch-checks.yml") -> list[str]:
    deploy_jobs = deploy_doc.get("jobs") or {}
    copy_jobs = copy_doc.get("jobs") or {}
    problems: list[str] = []

    for name in COPY_JOBS:
        d = deploy_jobs.get(name)
        c = copy_jobs.get(name)
        if not d:
            problems.append(f"{deploy_name} has no job `{name}`")
        if not c:
            problems.append(f"{copy_name} has no job `{name}`")
        if not d or not c:
            continue

        d_keys = {k: v for k, v in d.items() if k not in JOB_KEYS_IGNORED}
        c_keys = {k: v for k, v in c.items() if k not in JOB_KEYS_IGNORED}
        if d_keys != c_keys:
            for key in sorted(set(d_keys) | set(c_keys)):
                if d_keys.get(key) != c_keys.get(key):
                    problems.append(
                        f"{name}: job key `{key}` differs\n"
                        f"    deploy.yml    : {d_keys.get(key)!r}\n"
                        f"    branch-checks : {c_keys.get(key)!r}"
                    )
        compare(name, [normalise(s) for s in job_steps(d)], [normalise(s) for s in job_steps(c)], problems)

        if name == "suite":
            for side, job in (("deploy.yml", d), ("branch-checks", c)):
                check_sharding(side, name, job, problems)
                steps = job_steps(job)
                if not any(is_tsc(s) for s in steps):
                    problems.append(f"{side} {name}: no `npx tsc --noEmit` step")
        else:
            for side, job in (("deploy.yml", d), ("branch-checks", c)):
                if not any(is_netns(s) for s in job_steps(job)):
                    problems.append(f"{side} {name}: no `test:netns` step")

        # What only deploy.yml has: the tests wait for the decision and obey it.
        if "decide" not in as_list(d.get("needs")):
            problems.append(f"deploy.yml {name}: must have `decide` in `needs`")
        if str(d.get("if", "")).strip() != SKIP_IF:
            problems.append(f"deploy.yml {name}: `if` must be exactly `{SKIP_IF}`, found {d.get('if')!r}")

    deploy = deploy_jobs.get("deploy")
    if not deploy:
        problems.append(f"{deploy_name} has no job `deploy`")
    else:
        missing = DEPLOY_NEEDS - set(as_list(deploy.get("needs")))
        if missing:
            problems.append(f"deploy.yml deploy: `needs` is missing {', '.join(sorted(missing))}")
        cond = " ".join(str(deploy.get("if", "")).split())
        gone = [p for p in DEPLOY_IF_PARTS if p not in cond]
        if gone:
            problems.append(f"deploy.yml deploy: `if` no longer mentions {', '.join(gone)}")

    group = str((deploy_doc.get("concurrency") or {}).get("group", ""))
    if "'deploy-hub-api'" not in group and group != "deploy-hub-api":
        problems.append(f"deploy.yml concurrency: the group must stay `deploy-hub-api`, found {group!r}")
    if (deploy_doc.get("concurrency") or {}).get("cancel-in-progress") is not False:
        problems.append("deploy.yml concurrency: `cancel-in-progress` must be false (a running deploy is never cancelled)")
    return problems


# ---------------------------------------------------------------------------
# The check proves itself: each of these must be reported by find_problems.
# ---------------------------------------------------------------------------

def _step_index(job: dict, pred: Callable[[dict], bool]) -> int:
    return next(i for i, s in enumerate(job["steps"]) if pred(s))


def _drop(side: str, job: str, pred: Callable[[dict], bool]):
    def mutate(deploy: dict, copy_: dict) -> None:
        doc = deploy if side == "deploy" else copy_
        steps = doc["jobs"][job]["steps"]
        del steps[_step_index(doc["jobs"][job], pred)]
    return mutate


def _edit_run(side: str, job: str, pred: Callable[[dict], bool], suffix: str):
    def mutate(deploy: dict, copy_: dict) -> None:
        doc = deploy if side == "deploy" else copy_
        step = doc["jobs"][job]["steps"][_step_index(doc["jobs"][job], pred)]
        step["run"] = str(step["run"]) + suffix
    return mutate


def _set_run(side: str, job: str, pred: Callable[[dict], bool], run: str):
    def mutate(deploy: dict, copy_: dict) -> None:
        doc = deploy if side == "deploy" else copy_
        doc["jobs"][job]["steps"][_step_index(doc["jobs"][job], pred)]["run"] = run
    return mutate


def _set(path: list, value, side: str):
    def mutate(deploy: dict, copy_: dict) -> None:
        node = deploy if side == "deploy" else copy_
        for key in path[:-1]:
            node = node[key]
        node[path[-1]] = value
    return mutate


def _both(*fns):
    def mutate(deploy: dict, copy_: dict) -> None:
        for fn in fns:
            fn(deploy, copy_)
    return mutate


def _add_step(side: str, job: str):
    def mutate(deploy: dict, copy_: dict) -> None:
        doc = deploy if side == "deploy" else copy_
        doc["jobs"][job]["steps"].insert(-1, {"name": "extra", "run": "echo extra"})
    return mutate


def _swap_first_two_run_steps(side: str, job: str):
    def mutate(deploy: dict, copy_: dict) -> None:
        doc = deploy if side == "deploy" else copy_
        steps = doc["jobs"][job]["steps"]
        idx = [i for i, s in enumerate(steps) if "run" in s][:2]
        steps[idx[0]], steps[idx[1]] = steps[idx[1]], steps[idx[0]]
    return mutate


def _drop_need(side: str, job: str, need: str):
    def mutate(deploy: dict, copy_: dict) -> None:
        doc = deploy if side == "deploy" else copy_
        doc["jobs"][job]["needs"] = [n for n in as_list(doc["jobs"][job]["needs"]) if n != need]
    return mutate


def _checkout_version(side: str, job: str):
    def mutate(deploy: dict, copy_: dict) -> None:
        doc = deploy if side == "deploy" else copy_
        step = doc["jobs"][job]["steps"][0]
        step["uses"] = "actions/checkout@v3"
    return mutate


def _change_env(side: str, job: str):
    def mutate(deploy: dict, copy_: dict) -> None:
        doc = deploy if side == "deploy" else copy_
        doc["jobs"][job]["env"]["ADMIN_JWT_SECRET"] = "changed"
    return mutate


SELF_TESTS: list[tuple[str, Callable[[dict, dict], None]]] = [
    ("jest step dropped from deploy.yml suite only", _drop("deploy", "suite", is_jest)),
    ("jest step dropped from branch-checks suite only", _drop("copy", "suite", is_jest)),
    ("tsc step dropped from deploy.yml suite only", _drop("deploy", "suite", is_tsc)),
    ("netns step dropped from deploy.yml only", _drop("deploy", "netns", is_netns)),
    ("netns step dropped from branch-checks only", _drop("copy", "netns", is_netns)),
    ("jest flags changed in deploy.yml only", _edit_run("deploy", "suite", is_jest, " --bail")),
    ("tsc step changed in branch-checks only", _edit_run("copy", "suite", is_tsc, " --strict")),
    ("netns command changed in deploy.yml only", _edit_run("deploy", "netns", is_netns, " --quick")),
    ("a step added to branch-checks suite only", _add_step("copy", "suite")),
    ("a step added to deploy.yml netns only", _add_step("deploy", "netns")),
    ("two steps swapped in deploy.yml suite only", _swap_first_two_run_steps("deploy", "suite")),
    ("a step's action version changed on one side", _checkout_version("copy", "netns")),
    ("a test env value changed on one side", _change_env("deploy", "suite")),
    ("the Postgres service changed on one side", _set(["jobs", "suite", "services", "postgres", "image"], "postgres:15", "copy")),
    ("the runner changed on one side", _set(["jobs", "netns", "runs-on"], "ubuntu-22.04", "deploy")),
    ("a shard dropped on both sides (1,2 with /3)",
     _both(_set(["jobs", "suite", "strategy", "matrix", "shard"], [1, 2], "deploy"),
           _set(["jobs", "suite", "strategy", "matrix", "shard"], [1, 2], "copy"))),
    ("the shard matrix changed on one side", _set(["jobs", "suite", "strategy", "matrix", "shard"], [1, 2, 3, 4], "copy")),
    ("the shard flag removed from deploy.yml", _set_run("deploy", "suite", is_jest, "npx jest --runInBand --forceExit")),
    ("fail-fast changed on one side", _set(["jobs", "suite", "strategy", "fail-fast"], True, "deploy")),
    ("suite no longer waits for decide", _drop_need("deploy", "suite", "decide")),
    ("netns no longer obeys the skip decision", _set(["jobs", "netns", "if"], "always()", "deploy")),
    ("deploy no longer waits for netns", _drop_need("deploy", "deploy", "netns")),
    ("deploy no longer waits for a test shard", _drop_need("deploy", "deploy", "suite")),
    ("deploy loses its main-only guard",
     _set(["jobs", "deploy", "if"], "needs.decide.result == 'success' && inputs.dry_run != true && needs.suite.result == 'success' && needs.netns.result == 'success' && needs.decide.outputs.skip_tests == 'true'", "deploy")),
    ("deploy ignores a dry run",
     _set(["jobs", "deploy", "if"], "github.ref == 'refs/heads/main' && needs.decide.result == 'success' && needs.suite.result == 'success' && needs.netns.result == 'success' && needs.decide.outputs.skip_tests == 'true'", "deploy")),
    ("the concurrency group renamed", _set(["concurrency", "group"], "deploy-other", "deploy")),
    ("a running deploy may be cancelled", _set(["concurrency", "cancel-in-progress"], True, "deploy")),
]


def self_test(deploy_doc: dict, copy_doc: dict) -> list[str]:
    """Names of the self-tests that FAILED (a change that was not reported)."""
    failed: list[str] = []
    baseline = find_problems(deploy_doc, copy_doc)
    if baseline:
        return ["the unchanged files are not in sync (" + baseline[0].splitlines()[0] + ")"]
    for label, mutate in SELF_TESTS:
        d, c = copy.deepcopy(deploy_doc), copy.deepcopy(copy_doc)
        try:
            mutate(d, c)
        except (KeyError, IndexError, StopIteration, TypeError) as err:
            failed.append(f"{label}: the change could not be applied ({type(err).__name__}: {err})")
            continue
        if d == deploy_doc and c == copy_doc:
            failed.append(f"{label}: the change did nothing")
        elif not find_problems(d, c):
            failed.append(f"{label}: NOT REPORTED")
    return failed


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    only_self_test = "--self-test" in sys.argv[1:]
    deploy_path = Path(args[0]) if len(args) > 0 else ROOT / ".github/workflows/deploy.yml"
    copy_path = Path(args[1]) if len(args) > 1 else ROOT / ".github/workflows/branch-checks.yml"
    deploy_doc = load_jobs(deploy_path)
    copy_doc = load_jobs(copy_path)

    problems = find_problems(deploy_doc, copy_doc, deploy_path.name, copy_path.name)
    if problems:
        print(f"{copy_path.name} is not a copy of the test jobs in {deploy_path.name}:")
        for p in problems:
            print("  - " + p)
        print("Change both files in the same commit. Never edit this script to make the check pass.")
        print("IN-SYNC FAIL")
        return 1

    failed = self_test(deploy_doc, copy_doc)
    if failed:
        print("The sync check no longer proves what it should (SELF_TESTS):")
        for f in failed:
            print("  - " + f)
        print("IN-SYNC FAIL")
        return 1
    print(f"self-test: {len(SELF_TESTS)} changes to the files, all reported")
    if not only_self_test:
        n = sum(len(job_steps(deploy_doc["jobs"][j])) for j in COPY_JOBS)
        print(f"suite and netns in {deploy_path.name} are copies of {copy_path.name}: {n} steps compared")
    print("IN-SYNC OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
