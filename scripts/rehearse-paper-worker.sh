#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

wrangler=./worker/node_modules/.bin/wrangler
if [[ ! -x "$wrangler" ]]; then
  echo "Install locked Worker dependencies before running the rehearsal." >&2
  exit 1
fi

state_dir=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/paper-worker.XXXXXX")
worker_pid=
cleanup() {
  if [[ -n "$worker_pid" ]]; then
    kill "$worker_pid" 2>/dev/null || true
    wait "$worker_pid" 2>/dev/null || true
  fi
  rm -rf -- "$state_dir"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

unset CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_KEY CLOUDFLARE_EMAIL
export WRANGLER_SEND_METRICS=false

migrations=(
  001_init.sql
  002_hardened.sql
  paper/003_request_admission_counters.sql
  031_usage_management.sql
  032_paper_order_idempotency.sql
)

for migration in "${migrations[@]}"; do
  printf 'Applying local paper migration %s\n' "$migration"
  if ! "$wrangler" d1 execute crypto-signal-bot-db --local --config wrangler.toml \
      --persist-to "$state_dir" --file "worker/migrations/$migration" >"$state_dir/migration.log" 2>&1; then
    printf 'Local paper migration failed: %s\n' "$migration" >&2
    exit 1
  fi
done

port=$(node --input-type=module -e '
  import { createServer } from "node:net";
  const server = createServer();
  server.listen(0, "127.0.0.1", () => {
    console.log(server.address().port);
    server.close();
  });
')
base_url="http://127.0.0.1:$port"
"$wrangler" dev --local --ip 127.0.0.1 --port "$port" --config wrangler.toml \
  --persist-to "$state_dir" >"$state_dir/worker.log" 2>&1 &
worker_pid=$!

for _ in {1..30}; do
  if ! kill -0 "$worker_pid" 2>/dev/null; then
    echo "The local paper Worker exited before readiness." >&2
    exit 1
  fi
  if grep -Fq "Ready on $base_url" "$state_dir/worker.log"; then
    node worker/scripts/smoke-check.mjs "$base_url"
    exit 0
  fi
  sleep 1
done
echo "The local paper Worker did not become ready within 30 seconds." >&2
exit 1
