#!/bin/bash
set -e

echo "=== PulsePay Dev Setup ==="

# Check prerequisites
echo "Checking prerequisites..."
node --version || { echo "Node.js not found. Install Node 18+"; exit 1; }
python --version || { echo "Python not found. Install Python 3.11+"; exit 1; }

# Install backend dependencies
echo ""
echo "Installing backend dependencies..."
cd "$(dirname "$0")/../backend"
npm install

# Install frontend dependencies
echo ""
echo "Installing frontend dependencies..."
cd "../frontend"
npm install

# Install CV service dependencies
echo ""
echo "Installing CV service dependencies..."
cd "../cv-service"
pip install -r requirements.txt

echo ""
echo "=== Setup Complete ==="
echo ""
echo "To start the services:"
echo "  Backend:    cd backend && npm run dev"
echo "  Frontend:   cd frontend && npm run dev"
echo "  CV Service: cd cv-service && python -m uvicorn main:app --reload --port 8000"
echo ""
echo "Or use: bash scripts/dev-start.sh"
