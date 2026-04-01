#!/usr/bin/env bash
set -euo pipefail

SERVER="188.245.49.145"
USER="vibez"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/deploy_vibez_ed25519}"
SSH="ssh -i $SSH_KEY"

# 1. Sync source
rsync -azP --delete -e "$SSH" \
  --exclude 'node_modules' --exclude '.git' \
  --exclude 'dist' --exclude '.env' \
  --exclude '.claude/worktrees' \
  . "$USER@$SERVER:~/source/"

# 2. Sync compose + env
$SSH "$USER@$SERVER" "mkdir -p ~/deploy"
scp -i "$SSH_KEY" docker-compose.prod.yml "$USER@$SERVER:~/deploy/docker-compose.yml"
scp -i "$SSH_KEY" env/prod.env "$USER@$SERVER:~/deploy/prod.env"

# 3. Build on server
$SSH "$USER@$SERVER" bash -s <<'REMOTE'
  cd ~/source
  podman build -t vibez:local -f Dockerfile .

  cd ~/deploy
  podman compose down --remove-orphans 2>/dev/null || true
  podman compose up -d

  # Cleanup old images
  podman image prune -af --filter "until=24h" 2>/dev/null || true

  echo "=== Deploy complete ==="
  podman compose ps
REMOTE
