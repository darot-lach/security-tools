---
name: dast
description: Run an OWASP ZAP DAST scan (baseline/api/full/auth) plus verification (nuclei/testssl) tools, against an authorized live FAPA host via security-tools' docker-compose. Use ONLY when explicitly asked to run a DAST scan, ZAP scan, or dynamic/live scan against fapa.allweb.cloud or develop-fapa.allweb.cloud -- never auto-trigger this, since it hits live production infrastructure.
disable-model-invocation: true
argument-hint: "[target=<host>] [baseline] [api] [full] [auth]"
metadata:
  category: dast
---

# DAST scan (OWASP ZAP + verification tools)

## Usage

`/dast [target=<host>] [variant] [variant] ...` -- an optional target-host override, plus zero or more space-separated variants, each run in the order listed below (not the order typed), each producing its own separate report:
- `baseline` -- passive-only, always safe/fast (also runs unconditionally regardless of what's listed -- see step 2)
- `api` -- spec-driven active scan of declared OpenAPI endpoints
- `full` -- full active scan of the whole site; slow and intrusive
- `auth` -- full authenticated scan; hours, requires local credential setup, only run on explicit request

`target=<host>` overrides `TARGET_HOST` for this invocation only (`.env` is left untouched) -- it **must** still be one of the two authorized hosts (see below); refuse/ask otherwise. If `api` is also requested, `TARGET_API_SPEC_URL` is derived as `https://<host>/v3/api-docs` for this invocation unless already customized for that host.

Examples:
- `/dast` -- baseline only, `.env` default host
- `/dast full` -- baseline + full active scan
- `/dast baseline api full` -- baseline + api + full, run back-to-back, one report each
- `/dast target=develop-fapa.allweb.cloud full` -- baseline + full, against the develop host instead of whatever `.env` has

Since `api`/`full`/`auth` are each independently slow/intrusive, running several together in one invocation means a long combined wall-clock time -- confirm that's actually wanted (e.g. "give me a full sweep") before combining `full` and `auth` in particular.

Wraps the `zap-baseline`, `zap-api`, `zap`, `nuclei`, and `testssl` services in `D:\Fapa\security-tools\docker-compose.yml`, plus the standalone `zap-auth/` Automation Framework plan (not a compose service).

The recon/discovery tools (`httpx`, `katana`, `gau`, `waybackurls`, `ffuf`) are deliberately **out of scope** for this skill: per the 2026-07-15 assessment's own plugin spec (`05-security-engine/dast.md`), their output feeds a separate **Asset Inventory** (surface-change alerts between scans), not the ZAP scan itself -- ZAP is seeded from the OpenAPI spec (`zap-api`) instead. They still exist as standalone `docker compose run --rm <tool>` services in `security-tools/` if that asset-inventory use case ever comes up; they're just not part of a DAST scan.

**Only `fapa.allweb.cloud` and `develop-fapa.allweb.cloud` are authorized DAST targets.** Refuse (or ask) if `TARGET_HOST` is set to anything else.

## Steps

1. Resolve the target: if `target=` was given, set `TARGET_HOST` inline for this invocation (PowerShell: `$env:TARGET_HOST="..."`) -- validate it's one of the two authorized hosts first; otherwise use `.env`'s existing `TARGET_HOST` (still confirm it's one of the two authorized hosts). Every command below passes `-f D:\Fapa\security-tools\docker-compose.yml` explicitly -- never `cd` into that directory first (the Bash tool's working directory persists across calls in this session, so a `cd` here would silently break unrelated file lookups for the rest of the conversation). `D:\Fapa\security-tools` assumes this clone's usual location -- if this invocation's own "Base directory for this skill: `<path>`" line ends in something other than `...\.claude\skills\dast`, strip that suffix from it instead to get the real repo root, and use that in place of `D:\Fapa\security-tools` everywhere below (including the `zap-auth` `-v` path in step 3).
2. Always start with the safe, fast, passive-only scan (this runs regardless of `<variant>`):
   ```
   docker compose -f D:\Fapa\security-tools\docker-compose.yml run --rm zap-baseline
   ```
   Output: `output/dast/<TARGET_HOST>/zap-baseline_<TARGET_HOST>.{html,json,md}`.
3. For each additional variant given (any of `api`, `full`, `auth` -- `baseline` alone needs no extra step since step 2 already covered it), run its matching command, one at a time, in this order regardless of how they were typed:
   - `api` -> `docker compose -f D:\Fapa\security-tools\docker-compose.yml run --rm zap-api` -- spec-driven active scan of declared OpenAPI endpoints (needs `TARGET_API_SPEC_URL` in `.env`)
   - `full` -> `docker compose -f D:\Fapa\security-tools\docker-compose.yml run --rm zap` -- full active scan of the whole site; slow and intrusive
   - `auth` -> **not** a compose service, run directly (absolute path in `-v`, not `${PWD}`, for the same cwd-independence reason as above):
     ```
     docker run --rm -v "D:\Fapa\security-tools\zap-auth:/zap/wrk" zaproxy/zap-stable:2.17.0 zap.sh -cmd -autorun /zap/wrk/automation.yaml
     ```
     Fill in real test-account credentials in `zap-auth/automation.yaml`'s `CHANGE_ME_USERNAME`/`CHANGE_ME_PASSWORD` placeholders locally only -- **never commit real credentials** into this tracked file. Expect hours, not minutes (this has taken close to its own 4-hour cap in practice).
4. Verification tools:
   ```
   docker compose -f D:\Fapa\security-tools\docker-compose.yml run --rm nuclei
   docker compose -f D:\Fapa\security-tools\docker-compose.yml run --rm testssl
   ```
   Output under `output/dast/<TARGET_HOST>/`.
5. Summarize findings from the `output/dast/<TARGET_HOST>/*.json` files produced. The app-required `Frontend-Name` request header is already injected via each `zap-*` service's Replacer `-z` config -- no extra step needed. If asked to compare against `D:\Fapa\2026-07-15\`, cross-reference by finding/PT-ID (e.g. PT-09 for the CORS finding) rather than re-listing every result.
