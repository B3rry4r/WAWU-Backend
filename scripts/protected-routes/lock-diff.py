#!/usr/bin/env python3
"""
What a branch changes in the protected route lock, compared with a base ref.

    python3 scripts/protected-routes/lock-diff.py origin/main HEAD

Prints, as Markdown (CI appends it to the job summary), every protected entry
the branch adds, removes or changes, and whether the lock hash moved. Exit 0
when the two locks are identical, 1 when they differ, 2 when the base has no
lock yet. Reads both sides with `git show`, never from the working tree.
"""
import json
import subprocess
import sys


def section(ref):
    try:
        raw = subprocess.check_output(
            ['git', 'show', f'{ref}:.pipeline/protected-registry.json'], stderr=subprocess.DEVNULL
        )
    except subprocess.CalledProcessError:
        return None
    return json.loads(raw).get('protectedRoutes')


def main():
    base_ref = sys.argv[1] if len(sys.argv) > 1 else 'origin/main'
    head_ref = sys.argv[2] if len(sys.argv) > 2 else 'HEAD'
    base, head = section(base_ref), section(head_ref)
    print(f'### Protected route lock: `{head_ref}` against `{base_ref}`\n')
    if base is None:
        print(f'`{base_ref}` has no protected route lock yet, so there is nothing to compare against.')
        return 2
    if head is None:
        print(f'**`{head_ref}` removes the protected route lock entirely.**')
        return 1
    b = {r['id']: r for r in base['routes']}
    h = {r['id']: r for r in head['routes']}
    added = sorted(set(h) - set(b))
    removed = sorted(set(b) - set(h))
    changed = sorted(i for i in set(b) & set(h) if b[i] != h[i])
    setup_changed = base.get('setup') != head.get('setup')
    same_hash = (base.get('lock') or {}).get('sha256') == (head.get('lock') or {}).get('sha256')
    if not (added or removed or changed or setup_changed) and same_hash:
        print('No change: the branch is checked against exactly the lock on the base.')
        return 0
    print('**This branch changes the lock.** A change lands only through this reviewed diff '
          '(docs/WORKFLOW.md section 9: the owner decides).\n')
    for title, ids in (('Added', added), ('Removed', removed), ('Changed', changed)):
        if ids:
            print(f'{title} ({len(ids)}):')
            for i in ids:
                print(f'- `{i}`')
            print()
    if setup_changed:
        print('The setup steps changed.\n')
    print(f'Lock sha256: `{(base.get("lock") or {}).get("sha256")}` -> `{(head.get("lock") or {}).get("sha256")}`')
    return 1


if __name__ == '__main__':
    sys.exit(main())
