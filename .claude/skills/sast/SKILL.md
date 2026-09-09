---
name: sast
description: Run a Semgrep static-analysis scan (security-audit + owasp-top-ten + java + docker rulesets) against a local FAPA repo checkout via security-tools' docker-compose. Use ONLY when explicitly asked to run SAST, a static-analysis scan, or a semgrep scan -- never auto-trigger this from a general code question.
disable-model-invocation: true
argument-hint: "[target=<name-or-path>]"
metadata:
  category: sast
---

# SAST scan (Semgrep)

## Usage

`/sast [target=<name-or-path>]` -- an optional target override; the ruleset itself always runs the full fixed 216-rule config (no ruleset selection).

`target=<name-or-path>` overrides which repo to scan for this invocation only (`.env`'s `TARGET_REPO`/`TARGET_NAME` are left untouched):
- A value containing `/` or `\` is a literal path -> set `TARGET_REPO` to it, derive `TARGET_NAME` from its final path segment.
- A plain word (e.g. `fapa-graph-service`) -> set `TARGET_NAME` to it and `TARGET_REPO` to `../projects/<name>` (matches this repo's existing sibling-checkout convention).
- Omitted -> use whatever `.env` already has.

Examples:
- `/sast` -- scan the `.env` default target
- `/sast fapa-graph-service` -- scan `../projects/fapa-graph-service`
- `/sast target=../projects/fapa-spa` -- scan an explicit path

Wraps the `semgrep` service in `D:\Fapa\security-tools\docker-compose.yml`. Never bump the pinned image tag to `:latest` -- see that repo's `CLAUDE.md`.

## Steps

1. This skill only resolves as `/sast` when the session's current directory is already `security-tools` (or a subdirectory of it) -- that's how Claude Code scopes directory-local skills, so by the time these steps run, plain relative `docker compose` commands (no `cd`, no absolute path) are already correct. Resolve the target: if `target=` was given, set `TARGET_REPO`/`TARGET_NAME` inline for this invocation (PowerShell: `$env:TARGET_REPO="..."; $env:TARGET_NAME="..."`); otherwise use `.env`'s existing values.
2. Run:
   ```
   docker compose run --rm semgrep
   ```
3. Output: `output/sast/<TARGET_NAME>/semgrep-report.json`.
4. Report findings grouped by severity/CWE. This ruleset (216 rules: `p/security-audit` + `p/owasp-top-ten` + `p/java` + `p/docker`) already exceeds the 2026-07-15 external assessment's captured run (92 rules actually executed per its `raw/semgrep.log`), so no config change is needed to match or exceed that baseline.
5. If asked to compare against `D:\Fapa\2026-07-15\`: note that bundle's own internal inconsistency before treating it as ground truth -- its `raw/semgrep.log` shows 0 findings for the run it captured, while `markdown/01-owasp-top10.md` / `02-pentest.md` cite specific Semgrep-sourced findings (e.g. `tainted-file-path`, `detected-bcrypt-hash`, `incomplete-sanitization`) that must have come from a different invocation. Don't silently reconcile this -- surface it.
