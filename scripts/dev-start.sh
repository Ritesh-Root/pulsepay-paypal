#!/bin/bash
set -e

ROOT="$(dirname "$0")/.."

echo "=== Starting PulsePay Dev Servers ==="
echo ""

# Start backend
echo "[Backend] Starting on port 5000..."
cd "$ROOT/backend" && npm run dev &
BACKEND_PID=$!

# Start CV service
echo "[CV Service] Starting on port 8000..."
cd "$ROOT/cv-service" && python -m uvicorn main:app --reload --port 8000 &
CV_PID=$!

# Start frontend
echo "[Frontend] Starting on port 3000..."
cd "$ROOT/frontend" && npm run dev &
FRONTEND_PID=$!

echo ""
echo "All services started:"
echo "  Frontend:   http://localhost:3000"
echo "  Backend:    http://localhost:5000"
echo "  CV Service: http://localhost:8000"
echo ""
echo "Press Ctrl+C to stop all services"

# Trap SIGINT to kill all processes
trap "kill $BACKEND_PID $CV_PID $FRONTEND_PID 2>/dev/null; exit 0" SIGINT SIGTERM

# Wait for all
wait
