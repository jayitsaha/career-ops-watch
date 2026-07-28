// Hourly career-ops watcher: pulls fresh upstream career-ops code, runs its
// zero-token scanners (curated watchlist + broad reverse-ATS discovery)
// against our own portals.yml + persisted dedup state, then summarizes any
// genuinely new postings with NVIDIA NIM and pushes a Telegram alert.
import { execFileSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  cpSync,
  rmSync,
} from "node:fs";
import path from "node:path";

const ROOT = process.cwd(); // career-ops-watch repo root
const SRC_DIR = path.join(ROOT, "career-ops-src");
const STATE_DIR = path.join(ROOT, "state");
const CONFIG_DIR = path.join(ROOT, "config");

const NIM_API_KEY = process.env.NIM_API_KEY;
const NIM_MODEL = process.env.NIM_MODEL || "meta/llama-3.1-8b-instruct";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const USER_PROFILE = `Incoming Georgia Tech MS in Computer Science student, specializing in Machine
Learning. Targeting: Data Science roles, Software Engineering roles, Applied
Scientist / Research Scientist roles, and roles at quantitative trading firms
(quant research, quant dev, quant trading). Prefers internships/new-grad roles
that are ML/DS/SWE/quant relevant; not interested in unrelated fields (sales,
non-technical, etc). These postings come from an automated ATS scan (career-ops),
so some may be full-time-only roles rather than internships — flag that in
your "Why" note when it looks like the case.`;

const PIPELINE_SKELETON = `# Pipeline\n\n## Pending\n\n## Processed\n`;

function sh(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

function shCapture(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", ...opts });
}

function setupSrc() {
  if (existsSync(SRC_DIR)) rmSync(SRC_DIR, { recursive: true, force: true });
  sh("git", [
    "clone",
    "--depth",
    "1",
    "https://github.com/santifer/career-ops.git",
    SRC_DIR,
  ]);
  sh("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: SRC_DIR,
  });
}

function restoreState() {
  const dataDir = path.join(SRC_DIR, "data");
  mkdirSync(dataDir, { recursive: true });

  cpSync(path.join(CONFIG_DIR, "portals.yml"), path.join(SRC_DIR, "portals.yml"));

  for (const f of ["scan-history.tsv", "portal-health.tsv"]) {
    const src = path.join(STATE_DIR, f);
    if (existsSync(src)) cpSync(src, path.join(dataDir, f));
  }
  const cacheSrc = path.join(STATE_DIR, "cache");
  if (existsSync(cacheSrc)) {
    cpSync(cacheSrc, path.join(dataDir, "cache"), { recursive: true });
  }

  // Fresh pipeline.md each run — everything appended this run is, by
  // definition, new (scan-history.tsv is what actually prevents re-adding
  // previously-seen URLs across runs).
  writeFileSync(path.join(dataDir, "pipeline.md"), PIPELINE_SKELETON);
}

function persistState() {
  mkdirSync(STATE_DIR, { recursive: true });
  const dataDir = path.join(SRC_DIR, "data");
  for (const f of ["scan-history.tsv", "portal-health.tsv"]) {
    const src = path.join(dataDir, f);
    if (existsSync(src)) cpSync(src, path.join(STATE_DIR, f));
  }
  const cacheSrc = path.join(dataDir, "cache");
  if (existsSync(cacheSrc)) {
    cpSync(cacheSrc, path.join(STATE_DIR, "cache"), { recursive: true });
  }
}

function runScans() {
  const results = { scan: null, scanFull: null };
  try {
    sh("node", ["scan.mjs"], { cwd: SRC_DIR });
    results.scan = "ok";
  } catch (e) {
    console.error("scan.mjs failed (continuing):", e.message);
    results.scan = "failed";
  }
  try {
    sh("node", ["scan-ats-full.mjs", "--since", "1", "--limit", "300"], {
      cwd: SRC_DIR,
    });
    results.scanFull = "ok";
  } catch (e) {
    console.error("scan-ats-full.mjs failed (continuing):", e.message);
    results.scanFull = "failed";
  }
  return results;
}

function parsePendingOffers() {
  const pipelinePath = path.join(SRC_DIR, "data", "pipeline.md");
  if (!existsSync(pipelinePath)) return [];
  const text = readFileSync(pipelinePath, "utf8");
  const lines = text.split("\n").filter((l) => l.startsWith("- [ ] "));

  return lines.map((line) => {
    const body = line.slice("- [ ] ".length);
    const parts = body.split(" | ").map((p) => p.trim());
    // scan.mjs / scan-ats-full.mjs both write: URL | Company | Title | Location
    const [url, company, title, location] = parts;
    return { url, company, title, location: location || "N/A" };
  });
}

async function summarizeWithNim(items) {
  const listText = items
    .map(
      (i, idx) =>
        `${idx + 1}. ${i.company} — ${i.title} (${i.location}) — ${i.url}`
    )
    .join("\n");

  const body = {
    model: NIM_MODEL,
    messages: [
      {
        role: "system",
        content: `You write short, high-signal job-alert reports for a job seeker. ${USER_PROFILE}
For each new posting given, judge relevance to the seeker's target roles. Output plain text
(no markdown headers) formatted for a Telegram message:
- Start with a one-line count summary.
- List the most relevant roles first, each as: "Company — Title (Location)\\nApply: URL\\nWhy: <one short clause>".
- If a posting is clearly irrelevant to the target roles, omit it entirely.
- Keep the whole message under 3500 characters.`,
      },
      { role: "user", content: listText },
    ],
    temperature: 0.3,
    max_tokens: 1200,
  };

  const res = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NIM_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    throw new Error(`NIM request failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || "(no summary generated)";
}

async function sendTelegram(text) {
  const chunks = [];
  for (let i = 0; i < text.length; i += 3900) chunks.push(text.slice(i, i + 3900));
  for (const chunk of chunks) {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: chunk,
          disable_web_page_preview: true,
        }),
      }
    );
    if (!res.ok) {
      throw new Error(`Telegram send failed: ${res.status} ${await res.text()}`);
    }
  }
}

async function main() {
  setupSrc();
  restoreState();
  const scanResults = runScans();
  console.log("Scan results:", scanResults);

  const offers = parsePendingOffers();
  console.log(`New postings found: ${offers.length}`);

  persistState();

  if (offers.length === 0) {
    console.log("No changes — nothing to notify.");
    return;
  }

  const report = await summarizeWithNim(offers);
  console.log("--- Report ---\n" + report);

  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    await sendTelegram(
      `[career-ops scan] ${offers.length} raw new postings, filtered below:\n\n${report}`
    );
    console.log("Telegram notification sent.");
  } else {
    console.log("Telegram secrets not set — skipping notification.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
