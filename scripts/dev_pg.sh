#!/usr/bin/env bash
# Manage an embedded PostgreSQL instance for local dev/tests.
# Usage: dev_pg.sh start|stop|status
set -euo pipefail
PGNATIVE="/tmp/pgtest/node_modules/@embedded-postgres/linux-arm64/native"
PGDATA="${PGDATA:-/tmp/designguide-pg}"
PGBIN="$PGNATIVE/bin"
PORT="${PGPORT:-55432}"
DB="${PGDB:-designguide}"
export PGDATA

case "${1:-start}" in
  start)
    if "$PGBIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; then
      echo "already running on port $PORT"; exit 0
    fi
    if [ ! -d "$PGDATA" ]; then
      "$PGBIN/initdb" -D "$PGDATA" -U postgres --auth=trust --no-locale --encoding=UTF8 >/dev/null
      printf "port = %s\nlisten_addresses = ''\nunix_socket_directories = '/tmp'\n" "$PORT" >> "$PGDATA/postgresql.conf"
    fi
    "$PGBIN/pg_ctl" -D "$PGDATA" -l "$PGDATA/server.log" -w start >/dev/null
    python3 - "$PORT" "$DB" <<'PY'
import sys, psycopg2
port, db = sys.argv[1], sys.argv[2]
c = psycopg2.connect(host="/tmp", port=port, user="postgres", dbname="postgres")
c.autocommit = True
cur = c.cursor()
cur.execute("SELECT 1 FROM pg_database WHERE datname=%s", (db,))
if not cur.fetchone():
    cur.execute(f'CREATE DATABASE "{db}"')
print(f"postgres ready on /tmp:{port} db={db}")
PY
    ;;
  stop) "$PGBIN/pg_ctl" -D "$PGDATA" -m fast -w stop >/dev/null && echo stopped ;;
  status) "$PGBIN/pg_ctl" -D "$PGDATA" status || true ;;
  *) echo "unknown command: $1"; exit 2 ;;
esac
