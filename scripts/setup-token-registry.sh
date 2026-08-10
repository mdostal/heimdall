#!/bin/bash
# setup-token-registry.sh

REGISTRY_DIR="$HOME/.heimdall"
REGISTRY_PATH="$REGISTRY_DIR/token-registry.json"

mkdir -p "$REGISTRY_DIR"

echo "Enter primary account token:"
read -s PRIMARY_TOKEN
echo
echo "Enter secondary account token:"
read -s SECONDARY_TOKEN
echo

cat > "$REGISTRY_PATH" <<EOF
{
  "schema_version": "1.0",
  "accounts": [
    {"id": "primary", "token": "$PRIMARY_TOKEN", "status": "healthy", "weekly_usage": 0, "cap_limit": 500000, "reset_at": null},
    {"id": "secondary", "token": "$SECONDARY_TOKEN", "status": "healthy", "weekly_usage": 0, "cap_limit": 500000, "reset_at": null}
  ],
  "active_account_id": "primary"
}
EOF

chmod 600 "$REGISTRY_PATH"
echo "Registry initialized at $REGISTRY_PATH"
