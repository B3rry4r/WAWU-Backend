#!/usr/bin/env python3
"""deploy-fast decision (DEPLOY-FAST): can the deploy skip its tests?

.github/workflows/deploy.yml runs this in its first job, `decide`. The tests
(jest in 3 shards, then test:netns) are skipped ONLY when the commit being
deployed has a tree byte-identical to a commit that already passed every
check this repo runs on a task branch, so the deploy would test the very same
files a second time.

The candidate commits:

  * HEAD itself (a fast-forward, a rebase merge, a push of a tested branch).
  * HEAD's second parent, for a merge commit, when `git rev-parse
    HEAD^{tree}` equals `git rev-parse HEAD^2^{tree}` (the branch already
    contained main, so the merge changed nothing the branch did not have).

A candidate counts when, on that exact head_sha, EVERY one of these has run
and passed (the newest run of the workflow, from an event that checks out
exactly that commit, concluded success, and every job of that run concluded
success):

  * Branch checks (.github/workflows/branch-checks.yml): deploy-test-in-sync,
    suite (shard 1 of 3), suite (shard 2 of 3), suite (shard 3 of 3), netns
    and contract must all be among the run's jobs.
  * Gates (.github/workflows/gates.yml).
  * Protected routes (.github/workflows/protected-routes.yml).

Anything else runs the tests: the trees differ, a run is missing, failed,
cancelled or still running, a job is missing, an API call fails, the checkout
is not the commit the run was started for. The script never exits non-zero for
those: it decides "run the tests". It also never skips the migrate, build,
restart or smoke test steps: those are the deploy job's and do not look at this.

Environment (set by deploy.yml):
  GITHUB_REPOSITORY  owner/name
  GITHUB_SHA         the commit the run was started for
  GITHUB_TOKEN       the run's own token (needs only `actions: read`)
  FORCE_TESTS        "true" runs the tests whatever the decision is (the
                     workflow_dispatch input `force_tests`, for proving the tests)
  GITHUB_OUTPUT      file the outputs are appended to (skip_tests, reason)
  GITHUB_STEP_SUMMARY  file the decision is appended to

The decision and the run ids it relied on are printed. The last line printed is
"DECISION skip_tests=true" or "DECISION skip_tests=false".
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from typing import Callable

API = "https://api.github.com"

# An event is trusted only when it checks out exactly the run's head_sha.
# `pull_request` runs of Branch checks and Gates check out GitHub's test merge
# of the pull request into its base, which can differ from the head; the
# Protected routes workflow checks out the pull request head itself.
BRANCH_CHECKS_JOBS = (
    "deploy-test-in-sync",
    "suite (shard 1 of 3)",
    "suite (shard 2 of 3)",
    "suite (shard 3 of 3)",
    "netns",
    "contract",
)
WORKFLOWS = (
    {"label": "Branch checks", "file": "branch-checks.yml",
     "events": ("push", "workflow_dispatch"), "jobs": BRANCH_CHECKS_JOBS},
    {"label": "Gates", "file": "gates.yml",
     "events": ("push", "workflow_dispatch"), "jobs": ()},
    {"label": "Protected routes", "file": "protected-routes.yml",
     "events": ("push", "pull_request"), "jobs": ()},
)


class Undecided(Exception):
    """Something we could not establish: the answer is "run the tests"."""


def git(*args: str) -> str:
    return subprocess.run(
        ["git", *args], check=True, capture_output=True, text=True
    ).stdout.strip()


def make_api_get(token: str, attempts: int = 3) -> Callable[[str], dict]:
    def api_get(path: str) -> dict:
        last: Exception | None = None
        for attempt in range(attempts):
            req = urllib.request.Request(
                API + path,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                    "User-Agent": "wawu-deploy-decide",
                },
            )
            try:
                with urllib.request.urlopen(req, timeout=20) as res:
                    return json.loads(res.read().decode("utf-8"))
            except urllib.error.HTTPError as err:
                last = err
                if err.code < 500 and err.code != 429:
                    break
            except (urllib.error.URLError, TimeoutError, ValueError) as err:
                last = err
            time.sleep(2 * (attempt + 1))
        raise Undecided(f"GitHub API {path.split('?')[0]} failed: {last}")

    return api_get


def candidates(head: str, git_fn: Callable[..., str]) -> list[tuple[str, str]]:
    """(sha, why it may stand for HEAD). HEAD first, then a merge's second parent."""
    out = [(head, "the commit itself")]
    parents = git_fn("rev-list", "--parents", "-n", "1", head).split()[1:]
    if len(parents) == 2:
        head_tree = git_fn("rev-parse", f"{head}^{{tree}}")
        second_tree = git_fn("rev-parse", f"{head}^2^{{tree}}")
        if head_tree == second_tree:
            out.append((parents[1], "second parent of the merge, same tree"))
    return out


def newest_run(workflow: dict, sha: str, repo: str, api_get: Callable[[str], dict]) -> dict | None:
    data = api_get(
        f"/repos/{repo}/actions/workflows/{workflow['file']}/runs?head_sha={sha}&per_page=100"
    )
    runs = [
        r for r in data.get("workflow_runs", [])
        if r.get("head_sha") == sha
        and r.get("event") in workflow["events"]
        and (r.get("head_repository") or {}).get("full_name") == repo
    ]
    if not runs:
        return None
    return max(runs, key=lambda r: (r.get("created_at") or "", r.get("id") or 0))


def run_problem(workflow: dict, run: dict | None, repo: str, api_get: Callable[[str], dict]) -> str | None:
    """Why this workflow's evidence does not count, or None when it does."""
    label = workflow["label"]
    if run is None:
        return f"{label}: no run on this commit from {'/'.join(workflow['events'])}"
    where = f"{label} run {run.get('id')}"
    if run.get("status") != "completed":
        return f"{where} is {run.get('status')}"
    if run.get("conclusion") != "success":
        return f"{where} concluded {run.get('conclusion')}"
    jobs_data = api_get(f"/repos/{repo}/actions/runs/{run['id']}/jobs?filter=latest&per_page=100")
    jobs = jobs_data.get("jobs", [])
    if jobs_data.get("total_count", len(jobs)) > len(jobs) or not jobs:
        return f"{where}: could not read all of its jobs"
    bad = [f"{j.get('name')} ({j.get('conclusion')})" for j in jobs if j.get("conclusion") != "success"]
    if bad:
        return f"{where}: job not successful: {', '.join(bad)}"
    names = {j.get("name") for j in jobs}
    missing = [n for n in workflow["jobs"] if n not in names]
    if missing:
        return f"{where}: missing job {', '.join(missing)}"
    return None


def decide(repo: str, sha: str, git_fn: Callable[..., str], api_get: Callable[[str], dict],
           log: Callable[[str], None]) -> tuple[bool, str, list[int]]:
    """(skip, reason, run ids relied on). Raises Undecided for what cannot be established."""
    head = git_fn("rev-parse", "HEAD")
    if head != sha:
        raise Undecided(f"checkout is {head[:12]}, the run was started for {sha[:12]}")
    log(f"deploying {head}  tree {git_fn('rev-parse', 'HEAD^{tree}')}")
    problems: list[str] = []
    for cand, why in candidates(head, git_fn):
        log(f"candidate {cand} ({why}), tree {git_fn('rev-parse', f'{cand}^{{tree}}')}")
        ids: list[int] = []
        cand_problems: list[str] = []
        for wf in WORKFLOWS:
            run = newest_run(wf, cand, repo, api_get)
            problem = run_problem(wf, run, repo, api_get)
            if problem:
                cand_problems.append(problem)
                log(f"  no: {problem}")
            else:
                ids.append(run["id"])
                log(f"  ok: {wf['label']} run {run['id']} ({run['event']}) {run.get('html_url', '')}")
        if not cand_problems:
            return True, f"tree identical to {cand[:12]} ({why}), which passed all three workflows", ids
        problems.append(f"{cand[:12]}: {cand_problems[0]}")
    reason = "; ".join(problems)
    return False, reason, []


def write_outputs(skip: bool, reason: str, ids: list[int], forced: bool) -> None:
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as fh:
            fh.write(f"skip_tests={'true' if skip else 'false'}\n")
            fh.write(f"reason={reason.replace(chr(10), ' ')}\n")
            fh.write(f"run_ids={','.join(str(i) for i in ids)}\n")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        lines = [
            "### Deploy tests: " + ("skipped" if skip else "will run"),
            "",
            f"- Reason: {reason}",
            f"- Runs relied on: {', '.join(str(i) for i in ids) or 'none'}",
        ]
        if forced:
            lines.append("- `force_tests` was set: the tests run whatever was decided.")
        with open(summary, "a", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")


def main() -> int:
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    sha = os.environ.get("GITHUB_SHA", "")
    token = os.environ.get("GITHUB_TOKEN", "")
    forced = os.environ.get("FORCE_TESTS", "").strip().lower() == "true"
    skip, reason, ids = False, "", []
    try:
        if not (repo and sha and token):
            raise Undecided("GITHUB_REPOSITORY, GITHUB_SHA or GITHUB_TOKEN is not set")
        skip, reason, ids = decide(repo, sha, git, make_api_get(token), print)
    except Undecided as err:
        skip, reason, ids = False, f"cannot decide: {err}", []
    except Exception as err:  # noqa: BLE001 - any surprise means "run the tests"
        skip, reason, ids = False, f"cannot decide: {type(err).__name__}: {err}", []
    print(f"reason: {reason}")
    print(f"run ids relied on: {', '.join(str(i) for i in ids) or 'none'}")
    if forced and skip:
        print("force_tests is set: the tests run although the decision is to skip them")
        skip = False
        reason = "force_tests was set (the decision was to skip: " + reason + ")"
    write_outputs(skip, reason, ids, forced)
    print(f"DECISION skip_tests={'true' if skip else 'false'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
