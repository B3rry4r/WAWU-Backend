#!/usr/bin/env python3
"""
Lists every Hub API route the web app and the admin dashboard call, read from
a git ref of each (never from a working tree, which may be on any branch),
and compares that list with `protectedRoutes` in
.pipeline/protected-registry.json.

    python3 scripts/protected-routes/extract-callers.py \
        --web ../wawuafrica --web-ref origin/main \
        --dashboard ../wawu-dashboard --dashboard-ref origin/main

Exit 0 when every route a client calls is protected and every protected route
is still called; exit 1 otherwise, naming each difference. `--json` prints the
extracted calls instead.

What counts as a call (MONEY-01):

  web        every apiFetch / apiFetchPaginated / rawFetch call under src/
             (src/lib/api/mocks excluded). A call with `baseUrl` goes to WAWU
             ID, not to this backend, and is skipped. A call whose path is a
             variable is resolved through VARIABLE_PATHS below; a call whose
             method is chosen at runtime counts as both methods.
  dashboard  every key of ROUTES (src/lib/api/contract/generated.ts) and
             OPS_ROUTES (ops.generated.ts) that a file outside
             src/lib/api/contract names. Declared-but-unused keys are not calls.
"""
import argparse
import io
import json
import os
import re
import subprocess
import sys
import tarfile

HERE = os.path.dirname(os.path.abspath(__file__))
REGISTRY = os.path.join(HERE, '..', '..', '.pipeline', 'protected-registry.json')

# `apiFetch(record.verifyPath, ...)` on the payment-return page: the path is
# whichever verify route the payment started from. Each place that sets a
# verifyPath is a caller of that route; listed here by the property's value.
VERIFY_PATH = re.compile(r'verifyPath:\s*(["`])(/api/hub/[^"`]+)\1')


def read_tree(repo, ref, prefix):
    """{path: text} for every .ts/.tsx file under `prefix` at `ref`."""
    data = subprocess.check_output(['git', '-C', repo, 'archive', '--format=tar', ref, prefix])
    files = {}
    with tarfile.open(fileobj=io.BytesIO(data)) as tar:
        for m in tar.getmembers():
            if m.isfile() and m.name.endswith(('.ts', '.tsx')):
                files[m.name] = tar.extractfile(m).read().decode('utf-8', 'replace')
    return files


def balanced_end(s, i, open_c, close_c):
    """Index of the bracket closing the one at s[i], skipping strings and templates."""
    depth, j, quote = 0, i, None
    while j < len(s):
        c = s[j]
        if quote:
            if c == '\\':
                j += 2
                continue
            if quote == '`' and s.startswith('${', j):
                j = balanced_end(s, j + 1, '{', '}') + 1
                continue
            if c == quote:
                quote = None
        elif c in '"\'`':
            quote = c
        elif c == open_c:
            depth += 1
        elif c == close_c:
            depth -= 1
            if depth == 0:
                return j
        j += 1
    return len(s) - 1


def first_string_arg(args):
    a = args.lstrip()
    if not a or a[0] not in '"\'`':
        return None
    q, k = a[0], 1
    while k < len(a):
        if a[k] == '\\':
            k += 2
            continue
        if q == '`' and a.startswith('${', k):
            k = balanced_end(a, k + 1, '{', '}') + 1
            continue
        if a[k] == q:
            return a[1:k]
        k += 1
    return None


def normalise(path):
    """`/api/hub/content/${id}?x=${y}` -> `/content/:x`."""
    path = re.sub(r'\$\{[^}]*\}$', '', path) if re.search(r'[?]|\$\{(qs|query|params|search|suffix)', path) else path
    path = path.split('?')[0]
    path = re.sub(r'\$\{[^}]*\}', ':x', path)
    path = re.sub(r':\w+', ':x', path)
    return path[len('/api/hub'):] if path.startswith('/api/hub') else path


def paths_of_variable(src, call_at, args):
    """`const path = cond ? `/api/hub/a` : `/api/hub/b`;` -> both literals."""
    ident = re.match(r'\s*([A-Za-z_$][\w$]*)\s*[,)]', args + ')')
    if not ident:
        return []
    decls = list(re.finditer(r'\b(?:const|let)\s+' + re.escape(ident.group(1)) + r'\s*=', src[:call_at]))
    if not decls:
        return []
    start = decls[-1].end()
    end = src.find(';', start)
    return re.findall(r'["`](/api/hub/[^"`]+)["`]', src[start:end])


CALL = re.compile(r'\b(apiFetchPaginated|apiFetch|rawFetch)\s*(<)?')


def web_calls(files):
    calls = []
    verify_paths = []
    for name, src in files.items():
        if '/mocks/' in name or name.endswith('lib/api/client.ts'):
            continue
        for m in VERIFY_PATH.finditer(src):
            line = src.count('\n', 0, m.start()) + 1
            verify_paths.append((m.group(2), f'{name}:{line}'))
        for m in CALL.finditer(src):
            i = m.end()
            if m.group(2):
                depth = 1
                while depth and i < len(src):
                    depth += {'<': 1, '>': -1}.get(src[i], 0)
                    i += 1
            while i < len(src) and src[i].isspace():
                i += 1
            if i >= len(src) or src[i] != '(':
                continue
            args = src[i + 1:balanced_end(src, i, '(', ')')]
            line = src.count('\n', 0, m.start()) + 1
            if re.search(r'\bbaseUrl\b', args):
                continue
            path = first_string_arg(args)
            fixed = re.search(r'method:\s*["\'](\w+)["\']', args)
            chosen = re.search(r'method:\s*\w+\s*\?\s*["\'](\w+)["\']\s*:\s*["\'](\w+)["\']', args)
            methods = [chosen.group(1), chosen.group(2)] if chosen else [fixed.group(1) if fixed else 'GET']
            if path is None:
                if 'verifyPath' in args:
                    calls.append(('VERIFY', None, f'{name}:{line}'))
                    continue
                candidates = paths_of_variable(src, m.start(), args)
                if not candidates:
                    calls.append(('UNRESOLVED', args.strip()[:60], f'{name}:{line}'))
                    continue
                for candidate in candidates:
                    for method in methods:
                        calls.append((method, normalise(candidate), f'{name}:{line} (via a path variable)'))
                continue
            for method in methods:
                calls.append((method, normalise(path), f'{name}:{line}'))
    out = []
    for method, path, ref in calls:
        if method == 'VERIFY':
            for vp, setter in verify_paths:
                out.append(('POST', normalise(vp), f'{setter} (verifyPath, called from {ref})'))
        else:
            out.append((method, path, ref))
    return out


def dashboard_calls(files):
    gen = next(v for k, v in files.items() if k.endswith('lib/api/contract/generated.ts'))
    ops = next(v for k, v in files.items() if k.endswith('lib/api/contract/ops.generated.ts'))
    declared = re.findall(r'^\s+(\w+): \{ method: "(\w+)", path: "([^"]+)" \}', gen + '\n' + ops, re.M)
    users = '\n'.join(v for k, v in files.items() if '/lib/api/contract/' not in k)
    out = []
    for key, method, path in declared:
        if re.search(r'["\']' + key + r'["\']|ROUTES\.' + key + r'\b', users):
            out.append((method, normalise(path), key))
    # The /api/ops proxy authenticates every operator call against this route itself.
    if re.search(r'/api/hub/admin/auth/me', users):
        out.append(('GET', '/admin/auth/me', 'src/app/api/ops/[key]/route.ts (ME_PATH)'))
    return out


def route_regex(path):
    return re.compile('^' + re.sub(r':\w+', '[^/]+', re.escape(path).replace('\\:', ':')) + '$')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--web', required=True)
    ap.add_argument('--web-ref', default='origin/main')
    ap.add_argument('--dashboard', required=True)
    ap.add_argument('--dashboard-ref', default='origin/main')
    ap.add_argument('--registry', default=REGISTRY)
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()

    calls = [('web',) + c for c in web_calls(read_tree(args.web, args.web_ref, 'src'))]
    calls += [('dashboard',) + c for c in dashboard_calls(read_tree(args.dashboard, args.dashboard_ref, 'src'))]

    if args.json:
        print(json.dumps([{'client': c, 'method': m, 'path': p, 'at': r} for c, m, p, r in calls], indent=2))
        return 0

    with open(args.registry) as fh:
        routes = json.load(fh)['protectedRoutes']['routes']
    table = [(r['method'], route_regex(r['path']), r) for r in routes]
    called = set()
    problems = []
    for client, method, path, ref in calls:
        if method == 'UNRESOLVED':
            problems.append(f'{client} {ref}: a call whose path is not a literal ({path}); resolve it by hand')
            continue
        hits = [r for m, rx, r in table if m == method and rx.match(path)]
        hits.sort(key=lambda r: r['path'].count(':'))
        if not hits:
            problems.append(f'{client} calls {method} {path} ({ref}) and it is NOT protected')
            continue
        # Every entry of that route counts, including its variants.
        called.update(r['id'] for r in hits if r['path'] == hits[0]['path'])
    for r in routes:
        if r['id'] not in called:
            problems.append(f'{r["id"]} is protected but neither client calls it any more (a removal task decides)')
    for p in problems:
        print(p)
    print(f'{len(calls)} call sites, {len(called)} of {len(routes)} protected entries called, {len(problems)} differences')
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main())
