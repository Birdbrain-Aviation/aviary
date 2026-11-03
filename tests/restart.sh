#!/bin/bash
# Rebuild the Linux test builds and (re)start all three apps without a window,
# for the browser tests in this folder. Data goes to a throwaway folder.
set -e
cd "$(dirname "$0")/.."
TMP=${AVIARY_TEST_DIR:-${TMPDIR:-/tmp}/aviary-test}
mkdir -p "$TMP/home"
for f in "$TMP"/*.pid; do [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null || true; rm -f "$f"; done
for p in 47710 47720 47730; do curl -s -X POST -H "Origin: http://127.0.0.1:$p" http://127.0.0.1:$p/api/quit >/dev/null 2>&1 || true; done
sleep 0.5
for a in owl heron mockingbird; do go build -o build/linux/$a ./cmd/$a; done
for a in owl heron mockingbird; do
  AVIARY_NO_BROWSER=1 AVIARY_STAY=1 AVIARY_HOME="$TMP/home" nohup build/linux/$a > "$TMP/$a.log" 2>&1 &
  echo $! > "$TMP/$a.pid"
done
sleep 0.8
for p in 47710 47720 47730; do curl -s -o /dev/null -w "$p:%{http_code} " http://127.0.0.1:$p/; done; echo
