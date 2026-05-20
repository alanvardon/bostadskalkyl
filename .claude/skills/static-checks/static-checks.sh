#!/usr/bin/env bash
# static-checks.sh — mechanical correctness checks for index.html
# Exit 0 on pass, 1 on any failure. Violations printed to stderr.

set -uo pipefail

VIOLATIONS=0
BRANCH=$(git branch --show-current)
WORKFLOW_DIR=".workflow/$BRANCH"
mkdir -p "$WORKFLOW_DIR"

fail() { printf '✗ FAIL — %s\n' "$1" >&2; VIOLATIONS=$((VIOLATIONS + 1)); }
pass() { printf '✓ PASS — %s\n' "$1"; }

DIFF_ADDED=$(git diff HEAD -- index.html | grep '^+' | grep -v '^+++' || true)

# 1. Syntax — node --check on extracted inline JS
awk '/^[[:space:]]*<script>[[:space:]]*$/{p=1;next}/^[[:space:]]*<\/script>[[:space:]]*$/{p=0}p' \
  index.html > "$WORKFLOW_DIR/syntax-check.js"
if node --check "$WORKFLOW_DIR/syntax-check.js" 2>/dev/null; then
  pass "Syntax: inline JS parses cleanly"
else
  node --check "$WORKFLOW_DIR/syntax-check.js" 2>&1 | sed 's/^/  /' >&2
  fail "Syntax: node --check failed (see above)"
fi

# 2. classList — no el.className = in added lines
CLS=$(echo "$DIFF_ADDED" | grep -E '\.className\s*=' || true)
if [ -n "$CLS" ]; then
  fail "classList: el.className = found (use classList.add/remove):"$'\n'"$(echo "$CLS" | sed 's/^./  /')"
else
  pass "classList: no el.className = assignments"
fi

# 3. Hex colours — no hardcoded hex in added lines
# Excludes CSS variable definitions (-- prefix) and :root block lines
HEX=$(echo "$DIFF_ADDED" | grep -Ei '#[0-9a-fA-F]{3,6}\b' | grep -v -- '--[a-zA-Z]' | grep -v ':root' || true)
if [ -n "$HEX" ]; then
  fail "Colours: hardcoded hex colour found (use CSS variables from :root):"$'\n'"$(echo "$HEX" | sed 's/^./  /')"
else
  pass "Colours: no hardcoded hex colours"
fi

# 4. New input IDs must appear in CURRENCY_IDS, NUMBER_IDS, or TEXT_IDS
NEW_IDS=$(echo "$DIFF_ADDED" | grep -E 'type="(text|number)"|data-type=' | grep -oE 'id="[^"]+"' | sed 's/id="//;s/"//' || true)
if [ -n "$NEW_IDS" ]; then
  while IFS= read -r id; do
    [ -z "$id" ] && continue
    if ! grep -qE "(CURRENCY_IDS|NUMBER_IDS|TEXT_IDS)\s*=\s*\[" index.html; then
      fail "IDs: ID arrays not found in index.html"
      break
    fi
    if ! grep -E "(CURRENCY_IDS|NUMBER_IDS|TEXT_IDS)" index.html | grep -qE "\"${id}\"|'${id}'"; then
      fail "IDs: input id=\"$id\" missing from CURRENCY_IDS, NUMBER_IDS, and TEXT_IDS"
    fi
  done <<< "$NEW_IDS"
  pass "IDs: new input IDs checked against arrays"
else
  pass "IDs: no new input elements in diff"
fi

# 5. localStorage keys — must start with bostadskalkyl_
LS_KEYS=$(echo "$DIFF_ADDED" | grep -oE "localStorage\.(setItem|getItem)\(['\"][^'\"]+['\"]" | grep -oE "['\"][^'\"]+['\"]" | tr -d "'\"" || true)
if [ -n "$LS_KEYS" ]; then
  ALL_OK=1
  while IFS= read -r key; do
    [ -z "$key" ] && continue
    if [[ "$key" != bostadskalkyl_* ]]; then
      fail "localStorage: key '$key' does not start with bostadskalkyl_"
      ALL_OK=0
    fi
  done <<< "$LS_KEYS"
  [ "$ALL_OK" -eq 1 ] && pass "localStorage: all new keys follow bostadskalkyl_* convention"
else
  pass "localStorage: no new localStorage keys in diff"
fi

echo ""
if [ "$VIOLATIONS" -gt 0 ]; then
  printf '%d violation(s) found.\n' "$VIOLATIONS" >&2
  exit 1
fi
echo "All static checks passed."
exit 0
