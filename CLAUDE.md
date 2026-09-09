# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Dockerized, version-pinned SAST/SCA/DAST security scanning tooling for the target
services (`backend-service`, `graph-service`, `frontend-spa`), which live in a
sibling checkout under `../projects/`. This is not an application — there is no
build/test/lint step for source code here. The entire repo is a `docker-compose.yml`
defining scan jobs plus their configs, and every command below is `docker compose run`.

It exists to reproduce, locally, the tool suite used by an external pipeline
(invoked as `/scan`) that produced a prior assessment but isn't available in this
environment.

## Setup

- Docker Desktop must be running (`docker version` should succeed).
- Copy `.env.example` to `.env` and fill in `NVD_API_KEY` (free key from
  https://nvd.nist.gov/developers/request-an-api-key — required, anonymous NVD access
  no longer works). `.env` also holds `TARGET_REPO`/`TARGET_NAME`/`TARGET_HOST`
  overrides.

## Commands

All commands run from this folder. Set env vars either in `.env` or inline via
PowerShell `$env:VAR = "..."` before the `docker compose run`.

```powershell
# SAST -- Semgrep (216 rules: p/security-audit + owasp-top-ten + java + docker;
# the bare p/security-audit pack alone misses taint-tracking rules)
$env:TARGET_REPO = "../projects/backend-service"
$env:TARGET_NAME = "backend-service"
docker compose run --rm semgrep
# -> output/sast/<TARGET_NAME>/semgrep-report.json

# SCA -- Trivy filesystem + IaC/config scan
docker compose run --rm trivy-fs
docker compose run --rm trivy-config
# -> output/sca/<TARGET_NAME>/{trivy-fs,trivy-config}-report.{json,html}
# (HTML via a second `trivy convert` invocation against the bundled /contrib/html.tpl
# template -- trivy's own --format flag only accepts one value at a time)

# SCA -- OWASP Dependency-Check (first run syncs the full NVD dataset, hours;
# see "Dependency-Check database" below to avoid repeating that)
docker compose run --rm dependency-check
# -> output/sca/<TARGET_NAME>/dependency-check-report.json

# SBOM -- Syft (primary) + cdxgen (supplementary, Java/Maven reachability)
docker compose run --rm syft
docker compose run --rm cdxgen
# -> output/sbom/<TARGET_NAME>/{sbom.cdx.json,sbom.spdx.json,cdxgen-sbom.cdx.json}
# Run `mvn package` (Java) / `npm install` (JS/TS) in TARGET_REPO first -- see
# "Pre-scan steps" note below.

# DAST -- against a live, authorized host only
$env:TARGET_HOST = "target-host.example.com"
docker compose run --rm zap-baseline   # passive-only, fast, non-intrusive
docker compose run --rm zap-api        # spec-driven active scan, needs TARGET_API_SPEC_URL
docker compose run --rm zap            # full active scan, intrusive/slow
docker compose run --rm nuclei
docker compose run --rm testssl        # writes both --jsonfile and --htmlfile
# -> output/dast/<TARGET_HOST>/

# DAST -- full authenticated scan (logs in via username/password + TOTP, then
# active-scans the entire /api/.* surface). NOT a docker-compose service --
# run the image directly against the AF plan:
docker run --rm -v "${PWD}/zap-auth:/zap/wrk" zaproxy/zap-stable:2.17.0 zap.sh -cmd -autorun /zap/wrk/automation.yaml
# Fill in zap-auth/automation.yaml's CHANGE_ME_USERNAME/CHANGE_ME_PASSWORD
# with a real test account LOCALLY ONLY -- never commit real credentials into
# this tracked file (see its header comment). Expect hours, not minutes: a
# full authenticated run has taken close to its own 4-hour cap in practice.
# -> zap-auth/zap-report.{html,json,md} (gitignored; only automation.yaml and
#    scripts/ are tracked)

# DAST recon chain -- standalone/additive, run before zap/nuclei if you want the
# original assessment's recon coverage (none of these auto-feed another service)
docker compose run --rm httpx
docker compose run --rm katana
docker compose run --rm gau           # built locally on first use
docker compose run --rm waybackurls   # built locally on first use
# -> output/dast/<TARGET_HOST>/{httpx-live.jsonl,katana-urls.txt,gau-urls.txt,waybackurls-urls.txt}
# `ffuf` exists but is NOT run by default -- both authorized hosts return a
# catch-all 200 for missing paths, so its -fs filter must be set to a measured
# baseline first (see README Troubleshooting) before it produces anything useful.
# Once it is: -of is set to `all`, so a real run writes
# ffuf-results.{json,ejson,html,md,csv,ecsv} in one pass.
```

Only `target-host.example.com` and `staging-target-host.example.com` are authorized DAST targets
(the two hosts the original assessment covered) — never point these at other hosts.

## Claude Code Skills

This repo ships 5 manual-invocation-only skills at `.claude/skills/`, each wrapping
the commands above: `/sast`, `/sca`, `/sbom`, `/dast`, `/secrets`. Every skill takes
an optional `target=<name-or-path>` override (falls back to `.env`'s
`TARGET_REPO`/`TARGET_NAME`, or `TARGET_HOST` for `/dast`), and where a category
wraps more than one tool, space-separated tool/variant tokens select which ones run
(e.g. `/sca trivy grype`, `/dast api full`) — see each skill's own `SKILL.md` for
its exact `argument-hint` and examples. None auto-trigger from plain conversation
(`disable-model-invocation: true` on all 5) — they only run when explicitly typed.

**These only resolve when the session's current directory is `security-tools`
itself (or a subdirectory).** Claude Code scopes directory-local skills to the
directory they live in — invoking `/dast` (etc.) while working in a sibling folder
(`../projects/...`, `../2026-07-15/`) fails with "unknown command"; `cd` into
`security-tools` first. Because of this precondition, every skill's own commands
are plain relative `docker compose run --rm <service>` — no `cd`, no absolute path
needed inside the skill itself, since cwd is already guaranteed correct by the time
it runs.

Caveat observed in practice: the skill *resolving* (no "unknown command") only proves
cwd was `security-tools`-scoped at the moment it was typed — it does **not** guarantee
the agent's own shell cwd is still there by the time it actually runs the docker
compose commands, if cwd drifted away in between (e.g. a `cd` left over from an
earlier, unrelated command in the same session). If a step fails with `no
configuration file provided: not found`, that's this — run `pwd` and `cd` back into
`security-tools` before retrying, rather than assuming the skill guarantees it.

`/sca grype` always regenerates the SBOM via `syft` before running, unconditionally —
it does not check whether `output/sbom/<TARGET_NAME>/sbom.cdx.json` already exists,
so results are never based on a stale SBOM from before the target's latest dependency
changes.

## Architecture

- **`docker-compose.yml`** is the single source of truth for every tool: image tags,
  scan flags, exclude lists, and volume mounts. There's no wrapper script — read a
  service's `command:` block directly to see exactly what flags a scan runs with.
  The one exception is `zap-auth/` — a ZAP Automation Framework plan, needed
  because an authenticated scan requires more than a single `-t <url>` flag (a
  real login session). It isn't wired into `docker-compose.yml` at all — see
  the DAST commands above.
- **`docker/recon-tools.Dockerfile`** builds `gau`, `waybackurls`, and `ffuf` locally
  (pinned `go install <module>@<tag/commit>` on `golang:alpine`, copied into a slim
  `alpine` runtime stage) because none of the three has a trustworthy, actively
  maintained, author-official Docker Hub image — unlike every other tool in this repo,
  which pulls a prebuilt image straight from its maintainer (ProjectDiscovery,
  Anchore, OWASP, etc.). `waybackurls` specifically has never published a semver tag,
  so it's pinned to an explicit commit SHA instead of a floating ref.
- **Pre-scan step**: run `npm install` (JS/TS) or `mvn package` (Java, also produces
  the `target/*.jar` dependency-check already relies on) in `TARGET_REPO` before
  `dependency-check`, `cdxgen`, or `semgrep` — the original assessment's
  `depcheck.log` had 37 "node_modules not found" warnings from skipping this step.
- **Tool versions are pinned deliberately and must never be bumped to `:latest`.**
  A version change can silently alter findings, and Dependency-Check's NVD data is
  stored in an embedded H2 database (`dependency-check-data/odc.mv.db`) whose schema
  is tied to the exact tool version that built it — mismatched versions across
  machines break it.
- **`dependency-check-data/`** is a persistent, gitignored NVD vulnerability database
  (~600MB+, ~385k CVE records). Treat it as expensive, stateful infrastructure, not a
  cache you can casually delete:
  - Run `docker compose run --rm dependency-check-update` on a schedule to keep it
    warm with incremental (not full) syncs; add `--noupdate` to the `dependency-check`
    service once that job is trusted, so scans never touch the network.
  - Never kill an in-progress update — an abrupt interruption can corrupt
    `odc.mv.db`/leave `odc.update.lock` stuck, forcing a full 385k-record re-download.
  - Back it up (`backups/dependency-check-data-<date>/`, gitignored) whenever it's
    confirmed clean, and it's portable across machines as long as the
    `owasp/dependency-check` image tag matches exactly on both ends.
  - `target/` is intentionally **not** excluded from the dependency-check scan (unlike
    every other service's `--exclude` list) — it holds the built Spring Boot fat jar
    that Dependency-Check's Jar Analyzer needs to identify the real dependency tree.
    Excluding it previously dropped detected dependencies from ~200+ to 34.
- **`output/`** is gitignored and organized as `sast|sca/<TARGET_NAME>/` or
  `dast/<TARGET_HOST>/` — every service's volume mounts route its report there.
- **`.claude/skills/`** holds the 5 Claude Code skill wrappers (see "Claude Code
  Skills" above). They don't add any scan logic of their own — just argument
  parsing (`target=`, tool/variant tokens) and step sequencing around the exact
  same `docker compose run --rm <service>` commands documented above.

## Known operational gotchas

- Trivy `fs`: default 5-minute timeout is too short (`--timeout 20m` is already set);
  large untracked binary directories (e.g. `backend-service`'s 1.9GB
  `file-storage/`) must be added to `--skip-dirs` or the secret scanner chokes on them.
- Trivy `fs` Java analyzer hits `repo.maven.apache.org` for live `pom.xml` metadata by
  default, which can 30-minute-IP-block on rate limiting — `--offline-scan` (already
  set) avoids this.
- `testssl.sh` upstream only publishes minor-version tags on Docker Hub (no patch-level
  pins available) — `3.2` is as pinned as it gets.
- `cdxgen`'s Java/Maven pass failed on this machine when originally run natively on
  Windows (`'C:\Program' is not recognized...` from an unquoted `mvn.exe` path). Fixed
  here by containerizing fully (image bundles its own JDK+Maven) rather than trying to
  quote the path — never run cdxgen natively against a Windows-path Maven install.
- `cdxgen` is pinned to the `cdxgen-java17` image variant, not `java11` — the original
  assessment's error log suggested JDK11 for general `cyclonedx-maven-plugin`
  compatibility, but `backend-service` (the only Maven/Java target here) actually
  targets `<java.version>17</java.version>` in its `pom.xml`; a JDK11-bundled image
  can't compile Java 17 source. Re-pick the variant if `TARGET_REPO`'s Java version
  ever changes. `ghcr.io/cdxgen/cdxgen-java17:v13` was confirmed pullable 2026-09-04.
- `ffuf` will report a "finding" for every path fuzzed against either authorized DAST
  host unless `-fs`/`-fc` is set to a measured baseline first — both hosts return a
  catch-all HTTP 200 for missing routes (SPA fallback). This is why it's not part of
  the default recon-chain commands above.
- Semgrep's current config (`p/security-audit`+`p/owasp-top-ten`+`p/java`+`p/docker`,
  216 rules) already exceeds what the original assessment ran (`auto`+`p/security-audit`)
  — no change needed there to match or exceed that run's coverage.
- `trivy-fs`/`trivy-config` fail if their generated JSON/HTML report files already
  exist from a prior run and haven't been cleared — `trivy convert` (the HTML step)
  in particular refuses to overwrite silently; if a run errors on this, move or
  delete the stale `output/sca/<TARGET_NAME>/trivy-*-report.*` files first.
- `testssl` and `grype` both refuse to overwrite an existing report file of the same
  name (`Fatal error: non-empty "..." exists`) — move the prior run's file aside
  (or delete it) before re-running against the same `TARGET_HOST`/`TARGET_NAME`.
- **A `/sast`, `/sca`, `/sbom`, `/dast`, or `/secrets` skill invocation fails with
  "unknown command"** unless the session's current directory is `security-tools`
  (or a subdirectory) at the moment it's typed — see "Claude Code Skills" above.
  This isn't a bug in the skill files; it's how Claude Code scopes directory-local
  skills. `cd` into `security-tools` and retry.
- **A skill's own `docker compose` step fails with `no configuration file provided:
  not found`** even though the skill itself resolved fine — the skill resolving only
  proves cwd was `security-tools`-scoped at the moment it was *typed*, not that it's
  still there when the step actually *runs*; cwd can drift away in between from an
  earlier, unrelated command left over in the same session. Run `pwd`, `cd` back into
  `security-tools`, and retry the step.
