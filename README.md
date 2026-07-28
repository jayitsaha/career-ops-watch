# career-ops-watch

Hourly GitHub Actions watcher built on top of
[santifer/career-ops](https://github.com/santifer/career-ops)'s zero-token
(no-LLM) portal scanners.

**Scope (narrowed 2026-07-29):** Summer 2027 internships, USA-based only, in
exactly three tracks — Data Scientist/Applied DS/Research Data Scientist,
Software Engineer/SWE (+ ML Engineer/Platform Engineer variants), and
Quantitative Research (not quant trading). Enforced two ways: `config/
portals.yml`'s `title_filter` (upstream, in career-ops itself) and a hard
"must mention 2027" text gate in `scripts/run.mjs` (`mentionsTargetYear`),
since most raw ATS postings carry no structured year field.

Every hour (`.github/workflows/career-ops-watch.yml`, offset 15 min past the
hour so it doesn't collide with `job-alert-bot`), it:

1. Shallow-clones the **latest** upstream `career-ops` source fresh (so we
   always get upstream provider fixes — this repo does not fork/vendor it).
2. Drops in our own `config/portals.yml` (target companies, title/location/
   visa filters) and restores persisted dedup state from `state/`.
3. Runs `node scan.mjs` — scans the curated `tracked_companies` list in
   `portals.yml` via direct ATS APIs (Greenhouse/Lever/Ashby/Workday/etc).
4. Runs `node scan-ats-full.mjs --since 1 --limit 300` — reverse ATS
   discovery: walks public Greenhouse/Lever/Ashby/Workday/iCIMS company
   directories for **any** company (not just the curated list) whose postings
   match our title/location filters, from the last 24h.
5. Anything genuinely new goes to an NVIDIA NIM model to filter/rank for
   relevance and write a short report, then to Telegram
   (same bot as `job-alert-bot`, messages prefixed `[career-ops scan]`).
6. Persists `data/scan-history.tsv` / `data/portal-health.tsv` / `data/cache/`
   back to `state/` so dedup and the 24h ATS-directory cache survive across
   runs (`data/pipeline.md` itself is reset each run — it's just a working
   scratch file for that run's scan, not something this repo needs to keep).

## Known coverage limits

- `scan.mjs` only gets zero-token API coverage for companies on a supported
  ATS. Several big names in `portals.yml` (Google, Meta, Apple, Netflix, Jane
  Street, most quant shops) run custom in-house career boards with no public
  ATS API — those are **not** covered by this automated pipeline. Catching
  those would require either Playwright-driven scraping (not zero-token /
  not free) or manually checking those specific career pages yourself.
- `scan-ats-full.mjs --limit 300` caps how many companies per ATS get
  scanned per run to keep the job under ~30 min; on a cold cache the first
  few runs may not cover every company on each ATS. The 24h cache
  (`data/cache/`, persisted in `state/`) means coverage improves and runs get
  faster after the first day.

## Required repo secrets

Settings → Secrets and variables → Actions → New repository secret:

- `NIM_API_KEY` — same key used by `job-alert-bot`
- `TELEGRAM_BOT_TOKEN` — same bot as `job-alert-bot`
- `TELEGRAM_CHAT_ID` — same chat id as `job-alert-bot`

Optional repo variable: `NIM_MODEL` (defaults to `meta/llama-3.1-8b-instruct`).

## Manual test run

Actions tab → "career-ops watch" → Run workflow.
