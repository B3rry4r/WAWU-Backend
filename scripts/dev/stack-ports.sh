# Port ownership helpers for scripts/dev/stack.sh (FIX-57). Sourced, never run.
# Linux only: they read /proc. A port answering is not enough to call a service
# UP, because another stack may hold that port while ours died on EADDRINUSE.
# A service is UP only when its own process (or a child of it) is the listener.

# Every PID below a PID, one per line (the PID itself is not listed).
descendants() {
  ps -e -o pid= -o ppid= | awk -v root="$1" '
    { ppid[$1] = $2; ids[NR] = $1 }
    END {
      keep[root] = 1; changed = 1
      while (changed) {
        changed = 0
        for (i in ids) { p = ids[i]; if (!(p in keep) && (ppid[p] in keep)) { keep[p] = 1; changed = 1 } }
      }
      for (p in keep) if (p != root) print p
    }'
}

# Connect test on the loopback address: the fallback where /proc has no socket table.
port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

# listening_hexes: the local port, in 4-digit upper case hex, of every TCP socket in LISTEN state (IPv4 and IPv6).
listening_hexes() {
  awk '$4 == "0A" { n = split($2, a, ":"); print a[n] }' /proc/net/tcp /proc/net/tcp6 2>/dev/null
}

# port_listening <port>: 0 when anything listens on the port, on any address.
port_listening() {
  local hex; printf -v hex '%04X' "$1"
  listening_hexes | grep -qx "$hex" && return 0
  port_open "$1"
}

# listener_pids <port>: the PIDs holding a listening socket on the port, one per line. Empty when none, or when the
# holder belongs to a user whose /proc/<pid>/fd this user cannot read.
listener_pids() {
  local hex inode; printf -v hex '%04X' "$1"
  for inode in $(awk -v h="$hex" '$4 == "0A" { n = split($2, a, ":"); if (a[n] == h) print $10 }' /proc/net/tcp /proc/net/tcp6 2>/dev/null | sort -u); do
    find /proc/[0-9]*/fd -maxdepth 1 -lname "socket:\\[$inode\\]" 2>/dev/null | sed -n 's#^/proc/\([0-9][0-9]*\)/fd/.*#\1#p'
  done | sort -un
}

# holder_text <port>: "pid 123 (node)" for the holder(s) of a port, or "a process this user cannot see".
holder_text() {
  local pids p out=""
  pids="$(listener_pids "$1")"
  [ -n "$pids" ] || { printf 'a process this user cannot see'; return 0; }
  for p in $pids; do out="$out${out:+, }pid $p ($(tr -d '\0' < "/proc/$p/comm" 2>/dev/null || echo '?'))"; done
  printf '%s' "$out"
}

# owns_port <pid> <port>: 0 only when the port has a listener and every listener is <pid> or one of its children.
owns_port() {
  local own l found=0
  own=" $1 $(descendants "$1" | tr '\n' ' ')"
  for l in $(listener_pids "$2"); do
    case "$own" in *" $l "*) found=1 ;; *) return 1 ;; esac
  done
  [ "$found" -eq 1 ]
}

# wait_owned <pid> <port> <url> <seconds>: 0 when the URL answers 2xx and the service's own process holds the port.
# 1 when the process died or time ran out. WAIT_WHY says why, for the failure message.
wait_owned() {
  local pid="$1" port="$2" url="$3" secs="$4" i
  WAIT_WHY=""
  for i in $(seq 1 "$secs"); do
    if owns_port "$pid" "$port" && curl -sf -m 3 -o /dev/null "$url" 2>/dev/null; then return 0; fi
    if [ ! -d "/proc/$pid" ]; then
      if port_listening "$port"; then
        WAIT_WHY="the process (pid $pid) exited, and port $port is held by $(holder_text "$port"), not by this service"
      else
        WAIT_WHY="the process (pid $pid) exited and port $port is not listening"
      fi
      return 1
    fi
    sleep 1
  done
  if port_listening "$port" && ! owns_port "$pid" "$port"; then
    WAIT_WHY="port $port is held by $(holder_text "$port"), not by this service (pid $pid)"
  else
    WAIT_WHY="no answer from $url in ${secs} s"
  fi
  return 1
}
