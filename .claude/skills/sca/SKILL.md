---
name: sca
description: Run a dependency/SCA scan (OWASP Dependency-Check + Trivy fs, optionally cross-checked with Grype via SBOM) against a local FAPA repo checkout via security-tools' docker-compose, correlating findings across tools to separate real CVEs from tool-specific false positives. Use ONLY when explicitly asked to run a dependency check, SCA scan, or vulnerable-dependency scan -- never auto-trigger this from a general code question.
disable-model-invocation: true
argument-hint: "[target=<name-or-path>] [dependency-check] [trivy] [trivy-config] [grype]"
metadata:
  category: sca
---

# SCA scan (Dependency-Check + Trivy, optional Grype cross-check)

## Usage

`/sca [target=<name-or-path>] [tool] [tool] ...` -- an optional target override, plus zero or more space-separated tool choices, each producing its own separate report:
- `dependency-check` -- OWASP Dependency-Check (NVD/CPE-based)
- `trivy` -- Trivy filesystem scan (`trivy-fs`)
- `trivy-config` -- Trivy IaC/misconfig scan
- `grype` -- 3rd-tool cross-check via SBOM (auto-runs its `syft`/`grype-db-update` prerequisites as needed)

No tool tokens given = default to `dependency-check` + `trivy` (today's core pair, matching the old report's parallel-tools methodology). `trivy-config` and `grype` are opt-in extras layered on top -- they don't replace the default pair unless `dependency-check`/`trivy` are also typed explicitly with other tokens present (in which case run only what was listed).

`target=<name-or-path>` overrides which repo to scan for this invocation only (`.env`'s `TARGET_REPO`/`TARGET_NAME` are left untouched):
- A value containing `/` or `\` is a literal path -> set `TARGET_REPO` to it, derive `TARGET_NAME` from its final path segment.
- A plain word (e.g. `fapa-graph-service`) -> set `TARGET_NAME` to it and `TARGET_REPO` to `../projects/<name>` (matches this repo's existing sibling-checkout convention).
- Omitted -> use whatever `.env` already has.

Examples:
- `/sca` -- dependency-check + trivy against the `.env` default target
- `/sca fapa-graph-service` -- same two tools, but against `../projects/fapa-graph-service`
- `/sca grype` -- dependency-check + trivy + grype cross-check
- `/sca target=../projects/fapa-spa trivy` -- only Trivy, against an explicit path

Wraps the `dependency-check`, `dependency-check-update`, `trivy-fs`, `trivy-config`, `grype`, and `grype-db-update` services in `D:\Fapa\security-tools\docker-compose.yml`. Mirrors both the 2026-07-15 assessment's methodology (Trivy + Dependency-Check run in parallel, correlated by `(purl, CVE)`) and this project's own prior cross-check work (which caught a `reactor-netty-core` false-positive pattern via imprecise CPE matching -- see [anchore/grype#1009](https://github.com/anchore/grype/issues/1009)).

## Steps

1. This skill only resolves as `/sca` when the session's current directory is already `security-tools` (or a subdirectory of it) -- that's how Claude Code scopes directory-local skills, so by the time these steps run, plain relative `docker compose` commands (no `cd`, no absolute path) are already correct. Resolve the target: if `target=` was given, set `TARGET_REPO`/`TARGET_NAME` inline for this invocation (PowerShell: `$env:TARGET_REPO="..."; $env:TARGET_NAME="..."`); otherwise use `.env`'s existing values. Also confirm `NVD_API_KEY` in `.env` -- required for Dependency-Check unless the local database is already warm and `--noupdate` applies (it does by default in this compose file).
2. Pre-scan step (do this first, do not skip): run `mvn package` (Java) or `npm install` (JS/TS) inside the target repo. Skipping this reproduces the old report's `depcheck.log` undercount ("node_modules not found" warnings, degraded JS-tree accuracy).
3. For each tool token given (or the default `dependency-check`+`trivy` pair if none given), run the matching command:
   - `dependency-check` -> first check `dependency-check-data/` freshness (recently modified, no stale `.lock` file); if stale or first run on this machine, `docker compose run --rm dependency-check-update` first (never kill this mid-run -- can corrupt `odc.mv.db`). Then:
     ```
     docker compose run --rm dependency-check
     ```
     Output: `output/sca/<TARGET_NAME>/dependency-check-report.{json,html,csv}`.
   - `trivy` ->
     ```
     docker compose run --rm trivy-fs
     ```
     Output: `output/sca/<TARGET_NAME>/trivy-fs-report.json`.
   - `trivy-config` ->
     ```
     docker compose run --rm trivy-config
     ```
     Output: `output/sca/<TARGET_NAME>/trivy-config-report.json`.
   - `grype` -> requires an SBOM as input (auto-generated, no confirmation needed -- cheap, non-destructive prerequisite): check whether `output/sbom/<TARGET_NAME>/sbom.cdx.json` exists; if it's missing, run `docker compose run --rm syft` first (if it already exists, skip straight to the next check -- existence alone counts as fresh enough; use the `sbom` skill separately first if you want to force a real regeneration). Then:
     ```
     docker compose run --rm grype-db-update # only if the grype DB is >5 days stale
     docker compose run --rm grype
     ```
     Output: `output/sca/<TARGET_NAME>/grype-report.json`.
4. Cross-reference all findings by component + CVE:
   - A CVE flagged by only one tool via an imprecise CPE/purl match (the `reactor-netty-core` pattern -- inheriting all of a parent library's historical CVEs) is **lower confidence**.
   - A CVE confirmed by 2+ independently-sourced tools, or independently verified via WebSearch against a vendor advisory/release-note/changelog, is **higher confidence**.
   - Report using this tiering -- not a raw dump of every tool's output.
