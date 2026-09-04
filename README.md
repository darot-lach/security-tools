# Security Scan Tools

Dockerized, version-pinned SAST/SCA/DAST tooling for the target services
(`backend-service`, `graph-service`, `frontend-spa`), built to reproduce a prior
assessment's tool suite locally.

**Why this exists:** the original report was produced by an external pipeline
(invoked as `/scan`) that isn't available in this environment, and it scanned a
different checkout path than the sibling `../projects/` layout used here. None of
the tools below are installed as native binaries on this machine — only Docker is
required.

## Prerequisites

- Docker Desktop running (`docker version` should succeed)
- A free NVD API key for Dependency-Check — request one at
  https://nvd.nist.gov/developers/request-an-api-key (no cost, just an email/org form)
- Copy `.env.example` to `.env` and fill in `NVD_API_KEY` (and optionally override
  `TARGET_REPO`/`TARGET_NAME`/`TARGET_HOST`)

## Tools & pinned versions

| Category | Tool | Image |
|---|---|---|
| SAST | Semgrep | `returntocorp/semgrep:1.175.0` |
| SCA / IaC | Trivy | `aquasec/trivy:0.74.0` |
| SCA | OWASP Dependency-Check | `owasp/dependency-check:13.0.0` |
| SCA (corroborating) | Grype | `anchore/grype:v0.118.0` |
| SBOM | Syft | `anchore/syft:v1.20.0` |
| SBOM (supplementary, Java/Maven reachability) | cdxgen | `ghcr.io/cdxgen/cdxgen-java17:v13` (matches backend-service's `<java.version>17</java.version>`) |
| Secret scanning | Gitleaks | `zricethezav/gitleaks:v8.18.4` |
| Secret scanning (verify) | TruffleHog | `trufflesecurity/trufflehog:3.90.8` |
| DAST | OWASP ZAP | `zaproxy/zap-stable:2.17.0` |
| DAST | Nuclei | `projectdiscovery/nuclei:v3.11.1` |
| DAST (TLS) | testssl.sh | `drwetter/testssl.sh:3.2` (upstream only publishes minor-version tags, no patch pin available) |
| DAST recon | httpx | `projectdiscovery/httpx:v1.10.0` |
| DAST recon | katana | `projectdiscovery/katana:v1.5.0` |
| DAST recon | gau | built locally (`docker/recon-tools.Dockerfile`) |
| DAST recon | waybackurls | built locally (`docker/recon-tools.Dockerfile`) |
| DAST recon (optional, not run by default) | ffuf | built locally (`docker/recon-tools.Dockerfile`) |

**Grype note:** the AISOP spec doc that suggested Grype referenced `0.79.x` — that
version ships/resolves a permanently stale vulnerability DB (schema v5, whose upstream
feed appears frozen at a build from 2026-03-09 no matter how many times you run
`db update`). Pinned to the current `v0.118.0` release instead, which resolves fine.

**Never change these to `:latest`.** A version drift changes findings silently, and if
the Dependency-Check database is ever copied to another machine (see below), both
sides must run the exact same tag — the NVD data lives in an embedded H2 database
whose schema is tied to the tool version that built it.

## Quick start

All commands run from this folder.

### SAST — Semgrep
```powershell
$env:TARGET_REPO = "../projects/backend-service"
$env:TARGET_NAME = "backend-service"
docker compose run --rm semgrep
```
Output: `output/sast/<TARGET_NAME>/semgrep-report.json`

Uses `p/security-audit` + `p/owasp-top-ten` + `p/java` + `p/docker` — the default
`p/security-audit`-only ruleset (83 rules) misses taint-tracking rules like
`tainted-file-path`; adding the others (216 rules total) is what actually reproduces
the original report's taint-tracking finding.

### SCA — Trivy (filesystem + config/IaC)
```powershell
docker compose run --rm trivy-fs
docker compose run --rm trivy-config
```
Output: `output/sca/<TARGET_NAME>/trivy-fs-report.json` and `trivy-config-report.json`

### SCA — OWASP Dependency-Check
```powershell
docker compose run --rm dependency-check
```
Output: `output/sca/<TARGET_NAME>/dependency-check-report.json`

**First run will be slow** (a few hours) — it has to sync the full NVD CVE dataset
(~385k records) into `dependency-check-data/`. See "Keeping the database warm" below
to avoid ever waiting on this again.

### Pre-scan steps for accurate SCA/SBOM results

Run these in `TARGET_REPO` **before** `dependency-check`, `cdxgen`, or `semgrep` —
otherwise dependency analyzers can't see your actual dependency tree:

```powershell
# JS/TS services (frontend-spa, graph-service, etc.)
npm install

# Java services (backend-service) -- also produces the target/*.jar that
# dependency-check's Jar Analyzer and cdxgen's Maven reachability pass both need
mvn package
```
The 2026-07-06 assessment's `depcheck.log` logged 37 "node_modules not found"-style
warnings because target repos weren't `npm install`ed first — this silently
undercounts JS/TS dependencies (and Java dependencies, if `target/` is missing).

### SBOM — Syft + Grype (corroborating SCA)
```powershell
docker compose run --rm syft               # generates the SBOM grype scans below
docker compose run --rm grype-db-update    # run at least once, and periodically after
docker compose run --rm grype
```
Output: `output/sbom/<TARGET_NAME>/sbom.cdx.json` + `sbom.spdx.json` (syft),
`output/sca/<TARGET_NAME>/grype-report.json`

`grype` has **no built-in staleness auto-fix** — if a scan fails with
`db could not be loaded: ... max allowed age is 5 days`, run `grype-db-update` again.

### SBOM — cdxgen (supplementary)
```powershell
docker compose run --rm cdxgen
```
Output: `output/sbom/<TARGET_NAME>/cdxgen-sbom.cdx.json`

Runs alongside Syft (doesn't replace it) — adds a deeper Java/Maven dependency-tree
pass via the `cyclonedx-maven-plugin` that Syft doesn't do. Run `mvn package`/
`npm install` first (see "Pre-scan steps" above). This is fully containerized
specifically to avoid a bug hit in the original 2026-07-06 run — see Troubleshooting.

### Secret scanning — Gitleaks (full history) + TruffleHog (live verification)
```powershell
docker compose run --rm gitleaks
docker compose run --rm trufflehog
```
Output: `output/secret/<TARGET_NAME>/gitleaks-report.sarif` and
`trufflehog-verified.jsonl`. TruffleHog only writes hits that passed live
verification (`--only-verified`) — an empty file is a clean result, not a failure.

### DAST — ZAP / Nuclei / testssl.sh
```powershell
$env:TARGET_HOST = "target-host.example.com"
docker compose run --rm zap
docker compose run --rm nuclei
docker compose run --rm testssl
```
Output under `output/dast/<TARGET_HOST>/`. Only run these against hosts you're
authorized to test — `target-host.example.com` / `staging-target-host.example.com` are the two
hosts the original assessment covered.

### DAST recon chain — httpx / katana / gau / waybackurls / (optional) ffuf

The original assessment ran these before zap/nuclei (stages
`recon -> discovery -> zap -> nuclei -> verify`). They're standalone, additive
services here — running them is optional and none of them auto-feed zap/nuclei;
there's still no wrapper/orchestrator in this repo by design.

```powershell
$env:TARGET_HOST = "target-host.example.com"
docker compose run --rm httpx
docker compose run --rm katana
docker compose run --rm gau
docker compose run --rm waybackurls
```
Output: `output/dast/<TARGET_HOST>/httpx-live.jsonl`, `katana-urls.txt`,
`gau-urls.txt`, `waybackurls-urls.txt`.

`gau` and `waybackurls` are built locally on first run (`docker compose build gau
waybackurls`) since neither publishes a trustworthy, author-official Docker Hub
image — see `docker/recon-tools.Dockerfile`.

`ffuf` is configured but **not run by default** — the original assessment skipped it
because both authorized hosts return a catch-all HTTP 200 for nonexistent paths (SPA
fallback routing), which makes naive fuzzing useless without first setting a
size/response filter. Before ever running it: fetch one deliberately-nonexistent path
against `TARGET_HOST`, note the response's byte size, and edit the `ffuf` service's
`-fs` value in `docker-compose.yml` to match (or use `-fc`/`-fw` instead). It also
needs a wordlist you provide yourself under `./wordlists/` (gitignored, not bundled —
e.g. SecLists' `raft-medium-directories.txt`).

## Keeping the Dependency-Check database warm

Don't let every scan run trigger a sync. Instead:

1. Run the update job on its own schedule (a nightly Windows Scheduled Task is a good
   fit — this is the "cron" equivalent on Windows):
   ```powershell
   docker compose run --rm dependency-check-update
   ```
2. As long as that job isn't killed mid-sync, subsequent runs only pull the *delta*
   since the last update (seconds, not hours) instead of a full resync.
3. Add `--noupdate` to the `dependency-check` service's scan command once you trust the
   update job is running reliably, so scans never touch the network at all.

**Do not `docker stop`/kill an in-progress update carelessly** — an abrupt interruption
can leave `odc.update.lock` and the embedded H2 database (`odc.mv.db`) in a state the
tool doesn't trust, forcing a full 385k-record re-download on the next run instead of a
clean resume. If you must stop it, prefer letting it finish, or accept the re-download.

## Backing up the NVD database

Given how expensive the initial full sync is (hours, and vulnerable to re-triggering
on any interruption), keep a dated backup of a known-good `dependency-check-data/`
whenever it's confirmed clean (no `odc.update.lock` present, last run ended with
`Check for updates complete`):

```bash
mkdir -p backups
cp -r dependency-check-data "backups/dependency-check-data-$(date +%F)"
```

To restore after a corruption/forced-resync scare:
```bash
rm -rf dependency-check-data
cp -r backups/dependency-check-data-<date> dependency-check-data
```
`backups/` is gitignored, same as the live data dir — this is a local safety net, not
something to commit.

## Exporting/importing the database across environments

`dependency-check-data/` is just a folder — copy it anywhere:

```bash
# On a separate Linux machine (e.g. to build the DB on different network/IP if this
# one gets rate-limited by NVD):
mkdir -p ~/dependency-check-data
docker run --rm -v ~/dependency-check-data:/usr/share/dependency-check/data \
  owasp/dependency-check:13.0.0 --updateonly --nvdApiKey "<key>"

# then copy back:
rsync -avz --delete ~/dependency-check-data/ your-user@windows-host:/path/to/security-tools/dependency-check-data/
```
Wait for `[INFO] Check for updates complete` and confirm `odc.update.lock` is gone
before copying. Must use the **same image tag** (`13.0.0`) on both ends.

## Directory layout

```
security-tools/
├── docker-compose.yml
├── docker/
│   └── recon-tools.Dockerfile  # local builds for gau/waybackurls/ffuf
├── .env                  # your local config, gitignored
├── .env.example
├── dependency-check-data/ # persistent NVD database (gitignored, ~600MB+)
├── .trivy-cache/          # persistent Trivy vulnerability DB (gitignored)
├── .grype-cache/          # persistent Grype vulnerability DB (gitignored, ~2GB)
├── wordlists/             # your own wordlists for ffuf (gitignored, not bundled)
└── output/
    ├── sast/<service>/
    ├── sca/<service>/
    ├── sbom/<service>/    # sbom.cdx.json/sbom.spdx.json (syft), cdxgen-sbom.cdx.json
    └── dast/<host>/       # zap/nuclei/testssl + httpx/katana/gau/waybackurls/ffuf
```

## Troubleshooting (lessons from getting this working)

- **Trivy `fs` fails with "context deadline exceeded"** — either the default 5-minute
  timeout is too short (fixed here with `--timeout 20m`), or a large data/binary
  directory is being scanned by the secret scanner. `backend-service` has a
  1.9GB `file-storage/` directory that must be skipped (already in
  `--skip-dirs` above) — check for similarly large untracked directories in any new
  service before scanning it.
- **Trivy `fs` fails with `429 Too Many Requests` from `repo.maven.apache.org`** —
  Trivy's Java analyzer tries to resolve `pom.xml` metadata against live Maven Central
  by default, which can get rate-limited (observed a 30-minute IP block).
  `--offline-scan` (already set on `trivy-fs`) prevents this entirely — this is also
  what the org's own `.gitlab-ci.yml` trivy-fs job uses.
- **Dependency-Check fails with `Invalid API Key, length of 0`** — anonymous NVD API
  access no longer works; an API key (see Prerequisites) is mandatory now.
- **testssl.sh version tag not found** — upstream (`drwetter/testssl.sh` on Docker Hub)
  only publishes `latest`, `3.2`, `3.0` — no patch-level tags. `3.2` is as pinned as
  it gets.
- **Semgrep shows 0 findings** — check which `--config` packs are in use. The bare
  `p/security-audit` pack (83 rules) does not include the taint-tracking rule that
  originally caught the reference finding; the fuller set used here (216 rules) does.
- **Grype fails with `exec: "sh": executable file not found in $PATH`** — its image has
  no shell, so `entrypoint: ["sh", "-c"]` + redirection (the pattern used for
  `trufflehog`, whose image *does* have a shell) doesn't work here. Use the native
  `--file <path>` flag instead (already set on the `grype` service).
- **Grype fails with `db could not be loaded: ... max allowed age is 5 days`** — its
  bundled/cached DB is too old and it does not auto-update on scan. Run
  `docker compose run --rm grype-db-update` first (and periodically). If that still
  doesn't help, the pinned version's DB schema feed itself may be stale/deprecated
  upstream (this is what happened with the AISOP spec's suggested `v0.79.x` — its
  schema-v5 feed was frozen at a March-2026 build no matter how many updates were run;
  bumping to the current `v0.118.0` fixed it).
- **Grype's entrypoint override fails with `exec: "grype": executable file not found`**
  — the image's actual entrypoint is the absolute path `/grype`, not the bare word
  `grype` on `$PATH`. Don't override `entrypoint:` for it at all; the image's default
  entrypoint already works.
- **cdxgen fails with `'C:\Program' is not recognized...`** — this was the original
  2026-07-06 assessment's failure mode, hit when cdxgen is run as a native Windows npm
  CLI that shells out to a host `mvn.exe` at an unquoted `C:\Program Files\...` path.
  The `cdxgen` service here avoids this entirely by running fully inside a container
  that bundles its own JDK + Maven — it never touches a Windows path. If you ever run
  cdxgen natively instead, quoting the path isn't a real fix; containerize it.
- **waybackurls has no version tags** — unlike gau/ffuf, `tomnomnom/waybackurls` has
  never published a semver release; `docker/recon-tools.Dockerfile` pins an explicit
  commit SHA instead of a floating `@latest`/`@master` ref. Re-check
  https://github.com/tomnomnom/waybackurls/commits/master before rebuilding this image
  and update the pinned SHA deliberately, not automatically.
- **ffuf "finds" every path you fuzz** — both authorized DAST targets return a
  catch-all HTTP 200 for nonexistent routes (SPA fallback), so an unfiltered scan is
  pure noise. Set `-fs` (or `-fc`/`-fw`) to the real baseline response size/count
  before trusting any `ffuf` result — see "DAST recon chain" above.
