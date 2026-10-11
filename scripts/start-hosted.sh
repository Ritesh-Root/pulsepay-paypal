#!/usr/bin/env bash
# Hosted demo entry point (root Dockerfile): bring the database schema up to date, then
# run the CV service on localhost:8000 and the backend (API + web app) on $PORT.
# If either process stops, the container exits so the host restarts it.
set -uo pipefail
cd /app

node backend/scripts/migrate.js || exit 1

/opt/cv/bin/uvicorn main:app --app-dir cv-service --host 127.0.0.1 --port 8000 &
node backend/server.js &

trap 'kill -TERM $(jobs -p) 2>/dev/null' TERM INT
wait -n
code=$?
kill -TERM $(jobs -p) 2>/dev/null
wait
exit "$code"
