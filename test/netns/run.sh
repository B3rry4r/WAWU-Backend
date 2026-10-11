#!/usr/bin/env bash
#
# npm run test:netns
#
# Runs the real-socket route-failure rig (connection-never-opened-rig.ts) in a
# PRIVATE network namespace and exits non-zero on anything but a clean pass.
# MONEY-18 round 4, R3-2.
#
# Why a script and not a jest spec: the rig needs a network that fails on
# purpose (iptables, a lowered tcp_retries2, loopback only), which takes
# root or a user namespace. A jest spec that cannot get one has to skip, and a
# skip reports green on every machine without the privilege while the only
# proof of a money rule (the route dying under an open connection is NOT
# "never sent") is not run. Here "cannot run" is a failure.
#
# Exit codes
#   0  every row and the shape of the run checked out
#   1  the rig reported a wrong row, did not finish, or took too long
#   2  the rig refused to start (not a private network namespace)
#   3  no private network namespace with loopback, sysctl and iptables could
#      be made here, or node is missing: NOT a pass, never a skip
#
# Needs Linux, `unshare`, `iptables`, `sysctl`, and root (the CI step runs it
# with sudo), or `sudo -n`, or user namespaces. It touches nothing outside the
# namespace it makes.

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1

cannot_run() {
  echo "test:netns CANNOT RUN: $1" >&2
  echo "test:netns exits 3. A rig that cannot run is a failure, not a pass: run it where root (or sudo, or user namespaces) and iptables are available." >&2
  exit 3
}

NODE="$(command -v node)" || cannot_run "node is not on the PATH"
[ -x "$NODE" ] || cannot_run "node is not executable at $NODE"
command -v unshare >/dev/null 2>&1 || cannot_run "unshare is not installed"
command -v timeout >/dev/null 2>&1 || cannot_run "timeout is not installed"

# Loopback up (`ip` if there is one, else the ioctl), a low retransmission
# limit, and iptables reachable: the namespace is only usable if all three work.
PRELUDE=$(
  cat <<'EOF'
(ip link set lo up 2>/dev/null || python3 -c "import fcntl,socket,struct;s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);f=struct.unpack('16sH14s',fcntl.ioctl(s,0x8913,struct.pack('16sH14s',b'lo',0,b'')))[1];fcntl.ioctl(s,0x8914,struct.pack('16sH14s',b'lo',f|1,b''))") && sysctl -w net.ipv4.tcp_retries2=3 >/dev/null && iptables -w 5 -S OUTPUT >/dev/null
EOF
)

WORK="$(mktemp -d)" || cannot_run "no temporary directory"
trap 'rm -rf "$WORK"' EXIT

# The first way of making a private network namespace that works here.
LAUNCHER=()
for candidate in "unshare -n" "sudo -n unshare -n" "unshare -rn"; do
  read -r -a try <<<"$candidate"
  if timeout 30 "${try[@]}" sh -c "$PRELUDE" >/dev/null 2>"$WORK/probe.err"; then
    LAUNCHER=("${try[@]}")
    break
  fi
  echo "test:netns: \"$candidate\" cannot make a usable namespace here: $(tail -n 1 "$WORK/probe.err")" >&2
done
[ "${#LAUNCHER[@]}" -gt 0 ] || cannot_run "no private network namespace could be made (tried unshare -n, sudo -n unshare -n, unshare -rn)"

echo "test:netns: running the rig in a private network namespace (${LAUNCHER[*]})"
timeout -k 10 170 "${LAUNCHER[@]}" sh -c "$PRELUDE && exec \"$NODE\" -r ts-node/register/transpile-only test/netns/connection-never-opened-rig.ts" 2>&1 | tee "$WORK/rig.out"
RC="${PIPESTATUS[0]}"

if [ "$RC" -ne 0 ]; then
  echo "test:netns FAILED: the rig exited $RC" >&2
  [ "$RC" -eq 2 ] && exit 2
  exit 1
fi
if ! grep -q '^DONE rows=16 wrong=0 problems=0$' "$WORK/rig.out"; then
  echo "test:netns FAILED: the rig exited 0 without its final 'DONE rows=16 wrong=0 problems=0' line" >&2
  exit 1
fi
echo "test:netns PASSED: 16 rows, none wrong"
exit 0
