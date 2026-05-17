#!/bin/bash
# .git/hooks/pre-commit — blocks commits containing secrets

PATTERNS=(
  'sk-ant-'           # Anthropic API keys
  'sk-live-'          # Stripe live keys
  'sk_live_'          # Stripe live keys (alt format)
  'ghp_'              # GitHub personal tokens
  'gho_'              # GitHub OAuth tokens
  'AKIA'              # AWS access keys
  'xox[bpors]-'       # Slack tokens
  'SG\.'              # SendGrid keys
  'eyJ'               # JWTs
  'BEGIN.*PRIVATE KEY' # Private key material
)

BLOCKED_FILES=('.env' 'credentials.json' 'id_rsa' '*.pem' '*.key')

for pattern in "${PATTERNS[@]}"; do
  if git diff --cached --diff-filter=ACM | grep -qE "$pattern"; then
    echo "BLOCKED: Found potential secret matching '$pattern'"
    echo "Remove the secret and try again."
    exit 1
  fi
done

for file in "${BLOCKED_FILES[@]}"; do
  if git diff --cached --name-only | grep -q "$file"; then
    echo "BLOCKED: Attempted to commit sensitive file: $file"
    exit 1
  fi
done

echo "Pre-commit security check passed."
exit 0