# PreToolUse hook — inspect scripts before bash executes them

**Verdict:** Worth building. It closes a real hole in the harness permission
model. But understand its limits — it's one layer of a defense-in-depth
strategy, not a silver bullet.

## Blocking prerequisite — read this first

This hook trusts the `scripts/` folder and skips content-scanning anything
there. That trust is only safe if the model cannot write to `scripts/`.
Before enabling the hook, add these deny rules to `.claude/settings.json`:

```json
"deny": [
  "Write(scripts/**)",
  "Edit(scripts/**)",
  "Write(.claude/agents/**)",
  "Edit(.claude/agents/**)",
  "Write(.claude/hooks/**)",
  "Edit(.claude/hooks/**)",
  "Write(.claude/skills/**)",
  "Edit(.claude/skills/**)"
]
```

Verify before flipping the hook on:

```bash
grep -E 'Write\(scripts|Edit\(scripts' .claude/settings.json
```

If you don't see both lines, the hook actively *hides* bypasses (it skips
scanning the directory the model can still edit). Do not proceed until the
deny rules are in place.

Note: `.claude/settings.json` itself is in the existing deny list, so the
user must edit it manually — Claude cannot. Same applies to wiring the hook
in (next-to-last section).

## The problem this solves

Your `.claude/settings.json` allowlist is per-command. You can permit
`Bash(git push -u origin feature/*)` and deny `Bash(git push --force *)`,
and the harness will enforce those rules on top-level Bash invocations.

But the harness only sees *the top-level invocation*. If `Bash(bash scripts/*)`
is permitted and the model runs `bash scripts/anything.sh`, the script's
internal commands run as a subprocess of bash — invisible to the permission
check. So in principle, the model could:

1. Write a new script: `Write(scripts/evil.sh)` with content `git push --force`
2. Run it: `Bash(bash scripts/evil.sh)`
3. Bypass the `Bash(git push --force *)` deny rule entirely.

In practice, you've already half-blocked step 1 (denying writes to certain
paths). The hook is the belt-and-braces for step 2 — inspect what the script
*contains* before letting bash execute it.

## How PreToolUse hooks work (90-second primer)

When Claude is about to call a tool, the harness pauses and runs matching
hooks. Each hook gets the tool name and inputs as **JSON on stdin** and
decides what happens via exit code:

| Exit code | Effect |
|---|---|
| `0` | Allow the tool call. Stdout shown to user. |
| `2` | **Block the tool call.** Stderr shown to the model — it sees the rejection. |
| Other non-zero | Non-blocking warning. Tool still runs. |

For a Bash call, stdin looks like:
```json
{"tool_name":"Bash","tool_input":{"command":"bash scripts/foo.sh"}}
```

## The hook script

Create `.claude/hooks/inspect-script.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

if ! command -v jq >/dev/null 2>&1; then
  echo "BLOCKED by inspect-script hook: jq is required but not installed" >&2
  exit 2
fi

PAYLOAD=$(cat)
COMMAND=$(echo "$PAYLOAD" | jq -r '.tool_input.command // ""')
LOG_FILE=".claude/hooks/inspect-script.log"

FORBIDDEN_PATTERNS=(
  # rewrites of remote history
  'git push --force([^-]|$)'           # plain --force, not --force-with-lease
  'git push --force-with-lease'        # still rewrites remote history
  'git push -f([^a-zA-Z]|$)'
  'git push .*--force'                 # catches ordering variants: `git push origin main --force`
  # destructive local ops
  'git reset --hard'
  'git clean -[a-zA-Z]*f'
  'rm -rf /'
  'rm -rf \$[A-Za-z_]'                # unquoted variable expansion risk (e.g. rm -rf $DIR)
  'rm -rf ~'
  # PR merge bypassing review
  'gh pr merge'
  # pipe-to-shell installer pattern
  'curl[^|]*\| *(ba)?sh'
  # indirect execution — closes most "Gaps table" cases
  '(^|[^a-zA-Z_])eval[[:space:]]'
  '(bash|sh|zsh)[[:space:]]+-c[[:space:]]'
  'xargs[^|]*[[:space:]](ba|z)?sh([[:space:]]|$)'
)

block() {
  local msg="$1"
  echo "BLOCKED by inspect-script hook: $msg" >&2
  echo "If intentional, edit the file directly so it shows up in review." >&2
  mkdir -p "$(dirname "$LOG_FILE")"
  printf '[%s] %s | command=%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$msg" "$COMMAND" >> "$LOG_FILE"
  exit 2
}

scan_text() {
  local label="$1" text="$2"
  for pattern in "${FORBIDDEN_PATTERNS[@]}"; do
    if echo "$text" | grep -qE "$pattern"; then
      block "$label contains forbidden pattern: $pattern"
    fi
  done
}

# 1. Scan the literal command line.
scan_text "command" "$COMMAND"

# 2. Scan every script the command invokes — unless it lives in a trusted
#    folder protected by the deny rules listed in the prerequisites.
#    Regex matches `bash foo.sh`, `sh foo.sh`, `zsh foo.sh`, and `./foo.sh`.
#    Note the asymmetric whitespace: interpreters require a space before the
#    path; `./` does not. Iterates so chained invocations are all scanned.
while IFS= read -r MATCH; do
  [[ -z "$MATCH" ]] && continue
  SCRIPT_PATH=$(echo "$MATCH" | awk '{print $NF}' | sed 's|^\./||')
  [[ -z "$SCRIPT_PATH" || ! -f "$SCRIPT_PATH" ]] && continue
  case "$SCRIPT_PATH" in
    scripts/*|.claude/skills/*) : ;;  # trusted — requires deny rules; see prerequisites
    *) scan_text "script $SCRIPT_PATH" "$(cat "$SCRIPT_PATH")" ;;
  esac
done < <(echo "$COMMAND" \
  | grep -oE '(^|[[:space:]])((bash|sh|zsh)[[:space:]]+|\./)[^[:space:]]+\.sh' \
  || true)

exit 0
```

Make it executable:
```bash
chmod +x .claude/hooks/inspect-script.sh
```

## Wire it in settings.json

User must edit `.claude/settings.json` manually (file is in the deny list).
Add:

```json
{
  "permissions": { "...": "your existing permissions" },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": ".claude/hooks/inspect-script.sh" }
        ]
      }
    ]
  }
}
```

`matcher: "Bash"` means the hook only fires on Bash tool calls — no point
inspecting Read/Edit/Write payloads here.

## Test before relying on it

```bash
# Should ALLOW
echo '{"tool_name":"Bash","tool_input":{"command":"git status"}}' \
  | .claude/hooks/inspect-script.sh; echo "exit=$?"

# Should BLOCK — literal force push
echo '{"tool_name":"Bash","tool_input":{"command":"git push --force origin main"}}' \
  | .claude/hooks/inspect-script.sh; echo "exit=$?"

# Should BLOCK — --force-with-lease still rewrites history
echo '{"tool_name":"Bash","tool_input":{"command":"git push --force-with-lease origin main"}}' \
  | .claude/hooks/inspect-script.sh; echo "exit=$?"

# Should BLOCK — eval indirection
echo '{"tool_name":"Bash","tool_input":{"command":"eval \"git push --force\""}}' \
  | .claude/hooks/inspect-script.sh; echo "exit=$?"

# Should BLOCK — bash -c indirection
echo '{"tool_name":"Bash","tool_input":{"command":"bash -c \"git reset --hard HEAD~5\""}}' \
  | .claude/hooks/inspect-script.sh; echo "exit=$?"

# Should BLOCK — forbidden pattern in untrusted script
cat > /tmp/evil.sh <<'EOF'
#!/bin/bash
git push --force origin main
EOF
echo '{"tool_name":"Bash","tool_input":{"command":"bash /tmp/evil.sh"}}' \
  | .claude/hooks/inspect-script.sh; echo "exit=$?"
rm /tmp/evil.sh

# Should BLOCK — ./script.sh form (regression test for old regex bug)
cat > /tmp/evil2.sh <<'EOF'
#!/bin/bash
git reset --hard HEAD~5
EOF
chmod +x /tmp/evil2.sh
echo '{"tool_name":"Bash","tool_input":{"command":"cd /tmp && ./evil2.sh"}}' \
  | .claude/hooks/inspect-script.sh; echo "exit=$?"
rm /tmp/evil2.sh

# Should BLOCK — second script in a chain (regression test for head-n1 bug)
cat > /tmp/ok.sh  <<'EOF'
#!/bin/bash
git status
EOF
cat > /tmp/bad.sh <<'EOF'
#!/bin/bash
git push --force
EOF
echo '{"tool_name":"Bash","tool_input":{"command":"bash /tmp/ok.sh && bash /tmp/bad.sh"}}' \
  | .claude/hooks/inspect-script.sh; echo "exit=$?"
rm /tmp/ok.sh /tmp/bad.sh

# Should ALLOW — trusted folder (only safe with scripts/** in deny list)
mkdir -p scripts && echo 'git status' > scripts/test.sh
echo '{"tool_name":"Bash","tool_input":{"command":"bash scripts/test.sh"}}' \
  | .claude/hooks/inspect-script.sh; echo "exit=$?"
rm scripts/test.sh
```

## Remaining gaps

The hook is genuinely useful but **not airtight**. Items still uncovered:

| Gap | Example | Mitigation |
|---|---|---|
| Scripts that `source` other scripts | `safe.sh` does `source evil.sh` | Disallow `source`/`.` in scripts, or recursively follow them in the hook |
| Obfuscation | `git push --$(echo force)` | Mostly unfixable against motivated attackers; the hook targets accidental + naive misuse |
| Non-`.sh` scripts | `python evil.py`, extensionless scripts | Broaden the path regex; add `python\|node\|ruby` to the interpreter list |
| Trusted-folder bypass | Model edits something in `scripts/` if `Write(scripts/**)`/`Edit(scripts/**)` deny rules are missing | **See prerequisites — this is the load-bearing assumption** |
| Exotic `xargs` with custom interpreter | `cat evil \| xargs -I {} python -c {}` | Add language-specific patterns as needed |

Already handled (relative to earlier drafts):

- `eval`, `bash -c`/`sh -c`/`zsh -c`, and plain `xargs ... sh` indirection
  are blocked via FORBIDDEN_PATTERNS.
- `git push --force-with-lease` is blocked explicitly.
- The `./script.sh` form is matched by the path regex (previously broken).
- Chained invocations like `bash a.sh && bash b.sh` are all scanned
  (previously only the first match was inspected).

Overlap note: `rm -rf *`, `gh pr merge`, and `git push --force *` are already
denied in `.claude/settings.json`. The hook duplicates them so they're also
caught when hidden inside a script body, not just on the top-level command.

## Defense in depth — the full picture

This hook is one of four layers. None alone is sufficient:

1. **Allowlist pinning.** `Bash(bash scripts/static-checks.sh)` exactly,
   not `Bash(bash scripts/*)`. This is the primary defense.
2. **Deny writes to script/agent/hook/skills/settings dirs.** `Write(scripts/**)`,
   `Edit(scripts/**)`, `Write(.claude/agents/**)`, `Edit(.claude/agents/**)`,
   `Write(.claude/hooks/**)`, `Edit(.claude/hooks/**)`,
   `Write(.claude/skills/**)`, `Edit(.claude/skills/**)`,
   `Write(.claude/settings.json)`, `Edit(.claude/settings.json)`.
3. **This hook.** Catches naive bypasses and gives the model clear feedback.
4. **`block-secrets.sh` as a PreToolUse hook** (not just a git hook) — same
   pattern, fires on Write/Edit, blocks secret patterns *before* they hit
   disk. Your current `block-secrets.sh` is a git pre-commit only. Worth
   porting (snippet below).

## Bonus — block-secrets as a Claude hook

Port to `.claude/hooks/block-secrets-pretool.sh` (parity with the existing
git pre-commit hook, including the `eyJ` JWT pattern):

```bash
#!/usr/bin/env bash
set -euo pipefail

if ! command -v jq >/dev/null 2>&1; then
  echo "BLOCKED by block-secrets-pretool hook: jq is required but not installed" >&2
  exit 2
fi

PAYLOAD=$(cat)
TOOL=$(echo "$PAYLOAD" | jq -r '.tool_name')

case "$TOOL" in
  Write) CONTENT=$(echo "$PAYLOAD" | jq -r '.tool_input.content') ;;
  Edit)  CONTENT=$(echo "$PAYLOAD" | jq -r '.tool_input.new_string') ;;
  *)     exit 0 ;;
esac

PATTERNS=(
  'sk-ant-'             # Anthropic API keys
  'sk-live-'            # Stripe live keys
  'sk_live_'            # Stripe live keys (alt format)
  'ghp_'                # GitHub personal tokens
  'gho_'                # GitHub OAuth tokens
  'AKIA'                # AWS access keys
  'xox[bpors]-'         # Slack tokens
  'SG\.'                # SendGrid keys
  'eyJ'                 # JWTs (parity with block-secrets.sh)
  'BEGIN.*PRIVATE KEY'  # Private key material
)
for p in "${PATTERNS[@]}"; do
  if echo "$CONTENT" | grep -qE "$p"; then
    echo "BLOCKED: write would introduce potential secret matching '$p'" >&2
    exit 2
  fi
done
exit 0
```

Wire with `matcher: "Write|Edit"`. Now secrets are blocked **before they
hit disk**, not just before they hit a commit.

## Action items

1. **Blocking precondition** — user manually adds to `.claude/settings.json`
   deny list: `Write(scripts/**)`, `Edit(scripts/**)`,
   `Write(.claude/agents/**)`, `Edit(.claude/agents/**)`,
   `Write(.claude/hooks/**)`, `Edit(.claude/hooks/**)`,
   `Write(.claude/skills/**)`, `Edit(.claude/skills/**)`. Verify with the
   `grep` from the prerequisites section. Do not move on until this is done.
2. Pin Bash allowlist entries to specific paths where possible.
3. Write `.claude/hooks/inspect-script.sh` from the snippet above. Run `chmod +x .claude/hooks/inspect-script.sh` manually — Claude cannot do this because `Bash(chmod *)` is in the deny list.
4. User wires the hook in `.claude/settings.json` under `hooks.PreToolUse`.
5. Run every test case above and confirm the expected ALLOW / BLOCK results.
6. (Bonus) Port `block-secrets.sh` to a PreToolUse hook using the snippet
   above. Wire with `matcher: "Write|Edit"`. Run `chmod +x` on it manually
   for the same reason. Note: the existing `.claude/hooks/block-secrets.sh`
   is also missing the executable bit — fix that at the same time.

## What to watch for

- **Don't claim this hook makes you safe.** It's one layer. The allowlist
  pinning and write-deny rules are the more important defenses.
- **Keep `FORBIDDEN_PATTERNS` short and high-signal.** Every false positive
  trains you to ignore the warnings, which defeats the point.
- **When you add a new forbidden pattern, test it.** The grep regex syntax
  trips people up — verify the pattern actually matches what you intend
  before relying on it.
- **Check the log file occasionally** (`.claude/hooks/inspect-script.log`)
  for false positives and patterns of attempted bypass. It's the audit trail.
