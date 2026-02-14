#!/bin/bash
set -euo pipefail

VERSION=$(jq -r .version package.json)
DEPLOY_DIR="/opt/guardian/v${VERSION}"

echo "Deploying guardian v${VERSION}..."

# Create guardian user (first-time only)
sudo useradd --system --no-create-home guardian 2>/dev/null || true

# Deploy
sudo mkdir -p "$DEPLOY_DIR" /etc/guardian /var/lib/guardian
sudo cp -r . "$DEPLOY_DIR/"
cd "$DEPLOY_DIR" && sudo -u guardian bun install --production
sudo ln -sfn "$DEPLOY_DIR" /opt/guardian/current

# Config (first-time only - won't overwrite existing)
sudo cp -n guardian.example.yaml /etc/guardian/guardian.yaml
sudo cp -n deploy/guardian.env.example /etc/guardian/guardian.env
sudo chmod 600 /etc/guardian/guardian.env /etc/guardian/guardian.yaml
sudo chown guardian:guardian /var/lib/guardian

# systemd
sudo cp deploy/guardian.service deploy/guardian.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now guardian.timer

echo "Deployed guardian v${VERSION}"
echo "Edit /etc/guardian/guardian.env and /etc/guardian/guardian.yaml before first run"
