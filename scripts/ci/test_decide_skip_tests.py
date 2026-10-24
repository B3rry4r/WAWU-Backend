#!/usr/bin/env python3
"""Tests for scripts/ci/decide_skip_tests.py (DEPLOY-FAST).

Real git (a throwaway repository in a temp folder, so tree identity and merge
parents are the real thing) and a fake GitHub API. No network, no token.

    python3 -m unittest scripts/ci/test_decide_skip_tests.py

deploy.yml runs this before it takes the decision.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import decide_skip_tests as d  # noqa: E402

REPO = "owner/repo"
GIT_ENV = {
    **os.environ,
    "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com",
    "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.com",
    "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_SYSTEM": os.devnull,
}


class Repo:
    """A tiny git repository: main, a branch that contains main, a branch that does not."""

    def __init__(self, path: str) -> None:
        self.path = path
        self.run("init", "-q", "-b", "main")
        self.commit("a.txt", "a", "A")
        self.A = self.sha()
        # up-to-date branch: contains main, so the merge has the branch's tree
        self.run("checkout", "-q", "-b", "fresh")
        self.commit("b.txt", "b", "B")
        self.B = self.sha()
        self.run("checkout", "-q", "main")
        self.run("merge", "--no-ff", "-q", "-m", "Merge fresh", "fresh")
        self.M_same = self.sha()
        # stale branch: main moves on after the branch was cut
        self.run("checkout", "-q", "-b", "stale", self.A)
        self.commit("c.txt", "c", "C")
        self.C = self.sha()
        self.run("checkout", "-q", "main")
        self.commit("d.txt", "d", "D")
        self.run("merge", "--no-ff", "-q", "-m", "Merge stale", "stale")
        self.M_diff = self.sha()
        # a plain one-parent commit
        self.commit("e.txt", "e", "E")
        self.E = self.sha()

    def run(self, *args: str) -> str:
        return subprocess.run(["git", "-C", self.path, *args], check=True, capture_output=True,
                              text=True, env=GIT_ENV).stdout.strip()

    def commit(self, name: str, text: str, msg: str) -> None:
        Path(self.path, name).write_text(text)
        self.run("add", name)
        self.run("commit", "-q", "-m", msg)

    def sha(self) -> str:
        return self.run("rev-parse", "HEAD")

    def at(self, ref: str):
        """A git function that answers as if `ref` were checked out (HEAD)."""
        def git_fn(*args: str) -> str:
            fixed = [ref if a == "HEAD" else a.replace("HEAD", ref) for a in args]
            return self.run(*fixed)
        return git_fn


def run_obj(rid: int, sha: str, event: str = "push", status: str = "completed",
            conclusion: str | None = "success", created: str = "2026-10-24T10:00:00Z",
            repo: str = REPO) -> dict:
    return {"id": rid, "head_sha": sha, "event": event, "status": status, "conclusion": conclusion,
            "created_at": created, "head_repository": {"full_name": repo},
            "html_url": f"https://github.com/{repo}/actions/runs/{rid}"}


def jobs_obj(names, conclusion="success") -> dict:
    jobs = [{"name": n, "conclusion": conclusion} for n in names]
    return {"total_count": len(jobs), "jobs": jobs}


BRANCH_JOBS = list(d.BRANCH_CHECKS_JOBS)


class FakeApi:
    def __init__(self) -> None:
        self.runs: dict[tuple[str, str], list[dict]] = {}
        self.jobs: dict[int, dict] = {}
        self.calls: list[str] = []
        self.fail = False

    def add(self, workflow_file: str, run: dict, jobs: dict) -> None:
        self.runs.setdefault((workflow_file, run["head_sha"]), []).append(run)
        self.jobs[run["id"]] = jobs

    def good(self, sha: str, base_id: int = 100) -> None:
        self.add("branch-checks.yml", run_obj(base_id + 1, sha), jobs_obj(BRANCH_JOBS))
        self.add("gates.yml", run_obj(base_id + 2, sha), jobs_obj(["Executable gates", "Baseline"]))
        self.add("protected-routes.yml", run_obj(base_id + 3, sha), jobs_obj(["v3"]))

    def __call__(self, path: str) -> dict:
        self.calls.append(path)
        if self.fail:
            raise d.Undecided("simulated API failure")
        m = re.match(rf"/repos/{REPO}/actions/workflows/([\w.-]+)/runs\?head_sha=(\w+)&per_page=100$", path)
        if m:
            return {"workflow_runs": list(self.runs.get((m.group(1), m.group(2)), []))}
        m = re.match(rf"/repos/{REPO}/actions/runs/(\d+)/jobs\?filter=latest&per_page=100$", path)
        if m:
            return self.jobs[int(m.group(1))]
        raise AssertionError(f"unexpected API call {path}")


class DecisionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.TemporaryDirectory()
        cls.repo = Repo(cls.tmp.name)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.tmp.cleanup()

    def decide(self, head: str, api: FakeApi, sha: str | None = None):
        lines: list[str] = []
        try:
            return d.decide(REPO, sha or head, self.repo.at(head), api, lines.append), lines
        except d.Undecided as err:
            return (False, f"cannot decide: {err}", []), lines

    def test_merge_with_branch_tree_skips_and_names_the_runs(self):
        api = FakeApi()
        api.good(self.repo.B)
        (skip, reason, ids), log = self.decide(self.repo.M_same, api)
        self.assertTrue(skip, reason)
        self.assertEqual(ids, [101, 102, 103])
        self.assertIn("second parent", reason)
        self.assertTrue(any("run 101" in line for line in log))

    def test_merge_whose_tree_differs_runs_the_tests(self):
        api = FakeApi()
        api.good(self.repo.C)  # the branch passed everything, but main moved on
        (skip, reason, ids), _ = self.decide(self.repo.M_diff, api)
        self.assertFalse(skip)
        self.assertEqual(ids, [])
        self.assertNotIn(self.repo.C, "".join(api.calls))  # the second parent is not even asked about

    def test_the_commit_itself_may_have_the_runs(self):
        api = FakeApi()
        api.good(self.repo.E)
        (skip, _, ids), _ = self.decide(self.repo.E, api)
        self.assertTrue(skip)
        self.assertEqual(ids, [101, 102, 103])

    def test_nothing_ran_runs_the_tests(self):
        (skip, reason, _), _ = self.decide(self.repo.M_same, FakeApi())
        self.assertFalse(skip)
        self.assertIn("no run", reason)

    def test_each_workflow_is_needed(self):
        for missing in ("branch-checks.yml", "gates.yml", "protected-routes.yml"):
            api = FakeApi()
            api.good(self.repo.B)
            del api.runs[(missing, self.repo.B)]
            (skip, reason, _), _ = self.decide(self.repo.M_same, api)
            self.assertFalse(skip, missing)

    def test_running_failed_or_cancelled_runs_do_not_count(self):
        for status, conclusion in (("in_progress", None), ("completed", "failure"), ("completed", "cancelled"),
                                   ("queued", None), ("completed", "skipped")):
            api = FakeApi()
            api.good(self.repo.B)
            api.runs[("branch-checks.yml", self.repo.B)][0].update(status=status, conclusion=conclusion)
            (skip, _, _), _ = self.decide(self.repo.M_same, api)
            self.assertFalse(skip, f"{status}/{conclusion}")

    def test_a_missing_or_unsuccessful_job_does_not_count(self):
        for names in ([n for n in BRANCH_JOBS if n != "netns"], [n for n in BRANCH_JOBS if n != "contract"],
                      [n for n in BRANCH_JOBS if n != "suite (shard 3 of 3)"]):
            api = FakeApi()
            api.good(self.repo.B)
            api.jobs[101] = jobs_obj(names)
            (skip, reason, _), _ = self.decide(self.repo.M_same, api)
            self.assertFalse(skip)
            self.assertIn("missing job", reason)
        for conclusion in ("failure", "skipped", "cancelled", None):
            api = FakeApi()
            api.good(self.repo.B)
            api.jobs[102]["jobs"][0]["conclusion"] = conclusion
            (skip, _, _), _ = self.decide(self.repo.M_same, api)
            self.assertFalse(skip, f"gates job {conclusion}")

    def test_jobs_that_were_not_all_read_do_not_count(self):
        api = FakeApi()
        api.good(self.repo.B)
        api.jobs[101]["total_count"] = 120
        (skip, _, _), _ = self.decide(self.repo.M_same, api)
        self.assertFalse(skip)
        api = FakeApi()
        api.good(self.repo.B)
        api.jobs[103] = {"total_count": 0, "jobs": []}
        (skip, _, _), _ = self.decide(self.repo.M_same, api)
        self.assertFalse(skip)

    def test_only_events_that_check_out_that_commit_count(self):
        api = FakeApi()
        api.good(self.repo.B)
        api.runs[("branch-checks.yml", self.repo.B)][0]["event"] = "pull_request"
        (skip, reason, _), _ = self.decide(self.repo.M_same, api)
        self.assertFalse(skip)
        self.assertIn("no run", reason)
        api = FakeApi()
        api.good(self.repo.B)
        api.runs[("protected-routes.yml", self.repo.B)][0]["event"] = "pull_request"  # it checks out the head
        (skip, _, _), _ = self.decide(self.repo.M_same, api)
        self.assertTrue(skip)
        api = FakeApi()
        api.good(self.repo.B)
        api.runs[("gates.yml", self.repo.B)][0]["event"] = "schedule"
        (skip, _, _), _ = self.decide(self.repo.M_same, api)
        self.assertFalse(skip)

    def test_a_workflow_dispatch_run_counts(self):
        api = FakeApi()
        api.good(self.repo.B)
        api.runs[("branch-checks.yml", self.repo.B)][0]["event"] = "workflow_dispatch"
        (skip, _, _), _ = self.decide(self.repo.M_same, api)
        self.assertTrue(skip)

    def test_a_run_from_another_repository_does_not_count(self):
        api = FakeApi()
        api.good(self.repo.B)
        api.runs[("branch-checks.yml", self.repo.B)][0]["head_repository"] = {"full_name": "fork/repo"}
        (skip, _, _), _ = self.decide(self.repo.M_same, api)
        self.assertFalse(skip)
        api = FakeApi()
        api.good(self.repo.B)
        del api.runs[("gates.yml", self.repo.B)][0]["head_repository"]
        (skip, _, _), _ = self.decide(self.repo.M_same, api)
        self.assertFalse(skip)

    def test_a_run_for_another_sha_does_not_count(self):
        api = FakeApi()
        api.good(self.repo.B)
        api.runs[("gates.yml", self.repo.B)][0]["head_sha"] = self.repo.A
        (skip, _, _), _ = self.decide(self.repo.M_same, api)
        self.assertFalse(skip)

    def test_the_newest_run_decides(self):
        api = FakeApi()
        api.good(self.repo.B)
        api.add("branch-checks.yml", run_obj(201, self.repo.B, conclusion="failure", created="2026-10-24T11:00:00Z"),
                jobs_obj(BRANCH_JOBS, "failure"))
        (skip, reason, _), _ = self.decide(self.repo.M_same, api)
        self.assertFalse(skip)
        self.assertIn("run 201", reason)
        api = FakeApi()
        api.good(self.repo.B)
        api.add("branch-checks.yml", run_obj(202, self.repo.B, conclusion="failure", created="2026-10-24T09:00:00Z"),
                jobs_obj(BRANCH_JOBS, "failure"))
        (skip, _, ids), _ = self.decide(self.repo.M_same, api)
        self.assertTrue(skip)
        self.assertEqual(ids[0], 101)

    def test_an_api_error_runs_the_tests(self):
        api = FakeApi()
        api.good(self.repo.B)
        api.fail = True
        (skip, reason, _), _ = self.decide(self.repo.M_same, api)
        self.assertFalse(skip)
        self.assertIn("cannot decide", reason)

    def test_a_checkout_that_is_not_the_commit_runs_the_tests(self):
        api = FakeApi()
        api.good(self.repo.B)
        (skip, reason, _), _ = self.decide(self.repo.M_same, api, sha=self.repo.E)
        self.assertFalse(skip)
        self.assertIn("checkout", reason)

    def test_the_first_candidate_with_all_three_wins_and_the_second_is_tried(self):
        # HEAD itself has only Gates (a push to main); its second parent has all three.
        api = FakeApi()
        api.add("gates.yml", run_obj(301, self.repo.M_same), jobs_obj(["Executable gates"]))
        api.good(self.repo.B)
        (skip, _, ids), log = self.decide(self.repo.M_same, api)
        self.assertTrue(skip)
        self.assertEqual(ids, [101, 102, 103])
        self.assertTrue(any("no:" in line for line in log))


class MainTests(unittest.TestCase):
    """main(): the outputs, the log, and what a surprise or the force input does."""

    def run_main(self, decide_result, forced: bool = False, raises: Exception | None = None):
        with tempfile.TemporaryDirectory() as tmp:
            out, summary = Path(tmp, "out"), Path(tmp, "summary")
            env = {"GITHUB_REPOSITORY": REPO, "GITHUB_SHA": "a" * 40, "GITHUB_TOKEN": "t",
                   "GITHUB_OUTPUT": str(out), "GITHUB_STEP_SUMMARY": str(summary),
                   "FORCE_TESTS": "true" if forced else ""}
            side = {"side_effect": raises} if raises else {"return_value": decide_result}
            with mock.patch.dict(os.environ, env), mock.patch.object(d, "decide", **side), \
                    mock.patch("builtins.print") as printed:
                code = d.main()
            lines = [str(c.args[0]) for c in printed.call_args_list if c.args]
            return code, out.read_text(), summary.read_text(), lines

    def test_skip_is_written_with_the_run_ids(self):
        code, out, summary, lines = self.run_main((True, "same tree", [1, 2, 3]))
        self.assertEqual(code, 0)
        self.assertIn("skip_tests=true\n", out)
        self.assertIn("run_ids=1,2,3\n", out)
        self.assertIn("1, 2, 3", summary)
        self.assertEqual(lines[-1], "DECISION skip_tests=true")

    def test_force_tests_overrides_a_skip(self):
        code, out, _, lines = self.run_main((True, "same tree", [1, 2, 3]), forced=True)
        self.assertEqual(code, 0)
        self.assertIn("skip_tests=false\n", out)
        self.assertEqual(lines[-1], "DECISION skip_tests=false")

    def test_any_surprise_runs_the_tests_and_exits_zero(self):
        for err in (d.Undecided("no"), RuntimeError("boom"), KeyError("x")):
            code, out, _, lines = self.run_main(None, raises=err)
            self.assertEqual(code, 0)
            self.assertIn("skip_tests=false\n", out)
            self.assertEqual(lines[-1], "DECISION skip_tests=false")

    def test_a_missing_token_runs_the_tests(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp, "out")
            env = {"GITHUB_REPOSITORY": REPO, "GITHUB_SHA": "a" * 40, "GITHUB_OUTPUT": str(out)}
            with mock.patch.dict(os.environ, env, clear=True), mock.patch("builtins.print"):
                self.assertEqual(d.main(), 0)
            self.assertIn("skip_tests=false\n", out.read_text())


if __name__ == "__main__":
    unittest.main()
