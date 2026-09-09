---
name: secrets
description: Run a secret-scanning pass (Gitleaks full git-history scan + TruffleHog live credential verification) against a local FAPA repo checkout via security-tools' docker-compose. Use ONLY when explicitly asked to run a secret scan, credential scan, or check for leaked/hardcoded secrets -- never auto-trigger this from a general code question.
disable-model-invocation: true
argument-hint: "[target=<name-or-path>] [gitleaks] [trufflehog]"
metadata:
  category: secrets
---

# Secret scan (Gitleaks + TruffleHog)

## Usage

`/secrets [target=<name-or-path>] [tool] [tool] ...` -- an optional target override, plus zero or more space-separated tool choices:
- `gitleaks` -- full git-**history** scan (all branches/commits, `--log-opts=--all`) -- catches a secret that was committed and later deleted, since it's still exposed in history
- `trufflehog` -- detection **plus live verification**: for each candidate secret it finds, it makes a minimal read-only auth check against that secret's own provider (e.g. GitHub, AWS) to confirm whether the credential is still valid *right now*, not just pattern-matched

No tool tokens given = run both (they check different things -- history coverage vs. live validity -- and are not redundant with each other).

`target=<name-or-path>` overrides which repo to scan for this invocation only (`.env`'s `TARGET_REPO`/`TARGET_NAME` are left untouched):
- A value containing `/` or `\` is a literal path -> set `TARGET_REPO` to it, derive `TARGET_NAME` from its final path segment.
- A plain word (e.g. `fapa-graph-service`) -> set `TARGET_NAME` to it and `TARGET_REPO` to `../projects/<name>` (matches this repo's existing sibling-checkout convention).
- Omitted -> use whatever `.env` already has.

Examples:
- `/secrets` -- gitleaks + trufflehog against the `.env` default target
- `/secrets gitleaks` -- just the history scan
- `/secrets target=fapa-spa trufflehog` -- just live-verification, against `../projects/fapa-spa`

Wraps the `gitleaks` and `trufflehog` services in `D:\Fapa\security-tools\docker-compose.yml`. Neither tool has native HTML output (verified via `--help`: gitleaks supports json/csv/junit/sarif only, trufflehog supports json/json-legacy/github-actions only) -- reports stay JSON/SARIF.

## Steps

1. This skill only resolves as `/secrets` when the session's current directory is already `security-tools` (or a subdirectory of it) -- that's how Claude Code scopes directory-local skills, so by the time these steps run, plain relative `docker compose` commands (no `cd`, no absolute path) are already correct. Resolve the target: if `target=` was given, set `TARGET_REPO`/`TARGET_NAME` inline for this invocation (PowerShell: `$env:TARGET_REPO="..."; $env:TARGET_NAME="..."`); otherwise use `.env`'s existing values. The target must be an actual git checkout (`.git` present) -- both tools scan git history, not just the working tree.
2. For each tool token given (or both, if none given), run the matching command:
   - `gitleaks` ->
     ```
     docker compose run --rm gitleaks
     ```
     Output: `output/secret/<TARGET_NAME>/gitleaks-report.sarif`.
   - `trufflehog` -> makes live outbound requests to each found secret's own provider to verify validity -- expected behavior, not a bug, and read-only/non-destructive:
     ```
     docker compose run --rm trufflehog
     ```
     Output: `output/secret/<TARGET_NAME>/trufflehog-verified.jsonl` (only-verified findings, by design -- see the service's `--only-verified` flag).
3. Report findings with file/line/commit context where available. Treat any `trufflehog`-verified hit as high-confidence (it's confirmed live, not just pattern-matched) and prioritize it over an unverified `gitleaks` pattern match on the same secret.
