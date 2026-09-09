---
name: sbom
description: Generate CycloneDX/SPDX SBOMs via Syft (primary) and cdxgen (Java/Maven reachability supplement) for a local FAPA repo checkout via security-tools' docker-compose. Use ONLY when explicitly asked to generate an SBOM or software bill of materials -- never auto-trigger this from a general code question.
disable-model-invocation: true
argument-hint: "[target=<name-or-path>] [syft] [cdxgen]"
metadata:
  category: sbom
---

# SBOM generation (Syft + cdxgen)

## Usage

`/sbom [target=<name-or-path>] [tool] [tool] ...` -- an optional target override, plus zero or more space-separated tool choices:
- `syft` -- primary SBOM generator (CycloneDX + SPDX)
- `cdxgen` -- supplementary Java/Maven reachability pass

No tool tokens given = run both (current default behavior).

`target=<name-or-path>` overrides which repo to scan for this invocation only (`.env`'s `TARGET_REPO`/`TARGET_NAME` are left untouched):
- A value containing `/` or `\` is a literal path -> set `TARGET_REPO` to it, derive `TARGET_NAME` from its final path segment.
- A plain word (e.g. `fapa-graph-service`) -> set `TARGET_NAME` to it and `TARGET_REPO` to `../projects/<name>` (matches this repo's existing sibling-checkout convention).
- Omitted -> use whatever `.env` already has.

Examples:
- `/sbom` -- syft + cdxgen against the `.env` default target
- `/sbom syft` -- just Syft
- `/sbom target=fapa-spa` -- both tools, against `../projects/fapa-spa`

Wraps the `syft` and `cdxgen` services in `D:\Fapa\security-tools\docker-compose.yml`.

## Steps

1. `cd D:\Fapa\security-tools`. Resolve the target: if `target=` was given, set `TARGET_REPO`/`TARGET_NAME` inline for this invocation as described above (PowerShell: `$env:TARGET_REPO="..."; $env:TARGET_NAME="..."`); otherwise use `.env`'s existing values.
2. Pre-scan step (do this first, do not skip): run `mvn package` (Java) or `npm install` (JS/TS) inside the target repo. The 2026-07-15 assessment's cdxgen run silently fell back to a **direct-dependencies-only** SBOM for the Maven service after its `cyclonedx-maven-plugin` and `mvn dependency:tree` both failed (a Windows Maven path-quoting bug) -- skipping this step reproduces that same degraded, incomplete result.
3. For each tool token given (or both, if none given), run the matching command:
   - `syft` ->
     ```
     docker compose run --rm syft
     ```
     Output: `output/sbom/<TARGET_NAME>/sbom.cdx.json`, `sbom.spdx.json`.
   - `cdxgen` ->
     ```
     docker compose run --rm cdxgen
     ```
     Output: `output/sbom/<TARGET_NAME>/cdxgen-sbom.cdx.json`.
4. Note: `sbom.cdx.json` (from the `syft` step) is what the `sca` skill's optional Grype step consumes as input. Run this `sbom` skill (with `syft` included) before `sca`'s Grype step if it hasn't already produced a fresh SBOM for the target.
