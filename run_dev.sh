#!/usr/bin/env bash
# One-command local bootstrap: embedded PostgreSQL + schema/seed + API server.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.local/bin:$PATH"
export DATABASE_URL="${DATABASE_URL:-postgresql+psycopg2://postgres@/designguide?host=/tmp&port=55432}"
export PGPORT=55432 PGDB=designguide PGDATA=/tmp/designguide-pg

echo "==> [1/3] starting embedded PostgreSQL"
./scripts/dev_pg.sh start

echo "==> [2/3] creating schema + seed data"
python3 -m backend.seed

echo "==> [3/3] starting API + interactive docs on http://127.0.0.1:8080"
exec python3 -m uvicorn backend.main:app --host 127.0.0.1 --port "${PORT:-8080}"
