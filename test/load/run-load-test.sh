#!/usr/bin/env sh
# Orchestrates the full k6 scenario set, including the Redis-outage window
# for the `redis_unavailable` scenario. Intended to run via the `k6`
# docker-compose service, which has the Docker CLI's target compose project
# reachable through the mounted socket (see docker-compose.loadtest.yml).
#
# Usage (from repo root):
#   docker compose -f docker-compose.yml -f docker-compose.loadtest.yml up --build k6
set -eu

EDGE_BASE_URL="${EDGE_BASE_URL:-http://edge}"
COMPOSE_FILE="${COMPOSE_FILE:-/workspace/docker-compose.yml}"

echo "== Banner API load test: 5,000 RPS configured workload =="
echo "This is a reproducible performance experiment, not a laptop-independent capacity guarantee."
echo

reset_replica() {
  replica="$1"
  curl --fail --silent --show-error --request POST \
    "${EDGE_BASE_URL}/__replica__/${replica}/__test__/reset" >/dev/null
}

reset_all() {
  reset_replica a
  reset_replica b
}

cleanup() {
  # `start` is idempotent. Always attempt recovery: the outage is scheduled
  # in a background subshell, so shell-local state there cannot safely drive
  # this parent-shell EXIT trap if k6 aborts while Redis is stopped.
  echo "[load-test] ensuring redis is running..."
  docker compose -f "$COMPOSE_FILE" start redis || true
}
trap cleanup EXIT INT TERM

# Reset state before the warm-cache phase and at every scenario boundary.
# This removes timing-dependent cache assumptions from the benchmark.
reset_all
(
  sleep 33
  echo "[load-test] reset for cold-cache phase"
  reset_all

  sleep 15
  echo "[load-test] reset for local-collapse phase"
  reset_all

  sleep 20
  echo "[load-test] reset for cross-instance phase"
  reset_all

  sleep 18
  echo "[load-test] reset and stop redis for fail-open phase"
  reset_all
  docker compose -f "$COMPOSE_FILE" stop redis
  sleep 20
  docker compose -f "$COMPOSE_FILE" start redis
) &
PHASE_PID=$!

k6 run --summary-export=/results/k6-summary.json /scripts/scenarios.js
wait "$PHASE_PID"

echo
echo "== Per-replica server-side counters =="
for replica in a b; do
  curl --fail --silent --show-error "${EDGE_BASE_URL}/__replica__/${replica}/metrics" \
    | grep -E 'cache_events_total|db_queries_total|request_collapsing_events_total|circuit_breaker_state' || true
done
