#!/bin/sh
# Create .env for the local demo from .env.example, with fresh random secrets.
# Leaves an existing .env alone. Needs openssl (macOS, Linux, Git Bash, WSL).
set -e
cd "$(dirname "$0")/.."
if [ -f .env ]; then
    echo ".env already exists; leaving it alone."
    exit 0
fi
awk -v pg="$(openssl rand -hex 16)" -v jwt="$(openssl rand -hex 32)" -v kms="$(openssl rand -hex 32)" '
    /^POSTGRES_PASSWORD=$/ { print "POSTGRES_PASSWORD=" pg; next }
    /^JWT_SECRET=$/        { print "JWT_SECRET=" jwt; next }
    /^KMS_DATA_KEY=$/      { print "KMS_DATA_KEY=" kms; next }
    { print }' .env.example > .env
echo "Wrote .env with fresh secrets."
echo "Optional: add PayPal sandbox keys (PAYPAL_CLIENT_ID/SECRET) and a Bedrock API key (AWS_BEARER_TOKEN_BEDROCK)."
