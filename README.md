# career-ops-watch

Hourly GitHub Actions watcher built on top of
[santifer/career-ops](https://github.com/santifer/career-ops)'s zero-token
(no-LLM) portal scanners.

**Scope:** Summer 2027 internships, USA-based only, in these tracks — Data
Scientist/Applied DS/Research Data Scientist, Software Engineer/SWE (+ ML/
Platform Engineer variants), Applied/Research Scientist/GenAI/LLM/Agentic, and
Quantitative Research + Quantitative Trading. Enforced two ways:
`config/portals.yml`'s `title_filter` (upstream, in career-ops itself) and a
hard "must mention 2027" text gate in `scripts/aggregate-and-notify.mjs`
(`mentionsTargetYear`), since most raw ATS postings carry no structured year
field.

## Architecture (matrix-parallelized)

Every hour (`.github/workflows/career-ops-watch.yml`, offset 15 min past the
hour so it doesn't collide with `job-alert-bot`), a `scan` job runs as a
**6-way matrix** — one leg for the curated `tracked_companies` watchlist
(`scan.mjs`) plus one leg per ATS source (`scan-ats-full.mjs --ats <source>`
for greenhouse/lever/ashby/workday/icims) — all in parallel instead of one
process working through them sequentially. Each leg:

1. Shallow-clones the **latest** upstream `career-ops` source fresh (so we
   always get upstream provider fixes — this repo does not fork/vendor it).
2. Drops in our own `config/portals.yml` and restores persisted dedup state.
3. Runs its scan slice (`--limit 2500` per ATS leg — parallelizing across 5
   ATS types lets each afford far more coverage per run than a single
   sequential process could in the same wall-clock time).
4. Uploads its findings + its own state delta as a build artifact.

A second `aggregate` job (`needs: scan`) then:

1. Downloads all 6 legs' artifacts and merges them (deduping by URL).
2. Applies the hard 2027 gate.
3. Batches the merged offers into chunks of 25 and judges relevance/tier/
   action **in parallel** across a pool of NVIDIA NIM API keys
   (`NIM_API_KEYS`, round-robin) — returns structured JSON per posting so
   merging across chunks is exact, not a text-stitching guess.
4. Formats one grouped (🔥 High / 🟡 Medium) report and sends it to Telegram.
5. Merges all 6 legs' `scan-history.tsv`/`portal-health.tsv`/`cache/` deltas
   into `state/` and commits them back.

## Known coverage limits

- `scan.mjs` only gets zero-token API coverage for companies on a supported
  ATS. Several big names in `portals.yml` (Google, Meta, Apple, Netflix, Jane
  Street, most quant shops) run custom in-house career boards with no public
  ATS API — those are **not** covered by this automated pipeline.
- There are ~38,000+ companies across the 5 ATS directories combined; even at
  2500/leg/hour this is not literally "every company, every hour" — genuinely
  scanning all of them in a single run risks the run overrunning into the
  next hour's trigger (runs would queue and the pipeline would fall behind).
  The current limits are a deliberate tradeoff between coverage and staying
  safely inside the hourly cadence.

## Required repo secrets

Settings → Secrets and variables → Actions → New repository secret:

- `NIM_API_KEYS` — comma-separated pool of NVIDIA NIM keys (round-robin
  across chunks). A single key also works (`NIM_API_KEY` is used as a
  fallback if `NIM_API_KEYS` is unset).
- `TELEGRAM_BOT_TOKEN` — same bot as `job-alert-bot`
- `TELEGRAM_CHAT_ID` — same chat id as `job-alert-bot`

Optional repo variable: `NIM_MODEL` (defaults to `meta/llama-3.1-70b-instruct`).

## Manual test run

Actions tab → "career-ops watch" → Run workflow.
