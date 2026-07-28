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
Learning. Wants ONLY Summer 2027 internships, USA-based, in these tracks:
(1) Data Scientist / Applied Data Scientist / Research Data Scientist,
(2) Software Engineer / SWE (including close variants: ML Engineer, Platform
Engineer intern roles), (3) Applied Scientist / Research Scientist / GenAI /
LLM / Agentic / RAG / Generative AI roles, (4) Quantitative Research (quant
research intern/researcher) AND Quantitative Trading (quant trader,
quantitative analyst, quant developer). Consider multiple phrasings/synonyms
per track when judging relevance, not just exact title matches. Drop postings
outside all four tracks, non-US postings, and full-time-only roles — omit
those entirely even if they were flagged as a raw match. These postings come
from an automated ATS scan (career-ops).`;

// Hard gate: most raw ATS postings carry no structured "year" field, so the
// title/company text itself must mention 2027 (case-insensitive) or this
// wrapper won't even send it to NIM for consideration.
function mentionsTargetYear(offer) {
  const text = `${offer.title} ${offer.company}`.toLowerCase();
  return text.includes("2027");
}

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
    sh("node", ["scan-ats-full.mjs", "--since", "1", "--limit", "1500"], {
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
    // scan.mjs / scan-ats-full.mjs both write: URL | Company | Title | [Location | Compensation]
    const [url, company, title, location, compensation] = parts;
    return {
      url,
      company,
      title,
      location: location || "N/A",
      compensation: compensation || null,
    };
  });
}

async function summarizeWithNim(items) {
  const listText = items
    .map(
      (i, idx) =>
        `${idx + 1}. ${i.company} — ${i.title} (${i.location})${
          i.compensation ? ` — comp: ${i.compensation}` : ""
        } — ${i.url}`
    )
    .join("\n");

  const body = {
    model: NIM_MODEL,
    messages: [
      {
        role: "system",
        content: `You write short, high-signal, ACTIONABLE job-alert reports for a job seeker. ${USER_PROFILE}
For each new posting given, judge relevance and assign a tier: 🔥 High or 🟡 Medium.
Output plain text (no markdown headers) formatted for a Telegram message:
- Do NOT invent or state any count/total numbers anywhere in your output — the caller already
  prepends an accurate count. Just start directly with the first tier group.
- Group by tier, 🔥 High first, then 🟡 Medium. Within a tier, sort most relevant first.
- Each item as exactly 4-5 lines, no blank line between items in the same tier:
  "N. Company — Title (Location)
  Apply: URL
  Comp: <range if given, else omit this line entirely>
  Why: <one short clause on fit>
  Action: <one concrete next step — e.g. "Apply directly, strong match" or "Ask Claude to run career-ops's prepare-application on this link to tailor your CV first">"
- If a posting is clearly irrelevant to the target roles, omit it entirely — do not list it even in a low tier.
- List every relevant posting given, in full — do not drop or truncate items to save space. The
  message will be automatically split into multiple Telegram messages if it's long; there is no
  length limit you need to enforce yourself.`,
      },
      { role: "user", content: listText },
    ],
    temperature: 0.3,
    max_tokens: 4000,
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
  const choice = data.choices?.[0];
  if (choice?.finish_reason === "length") {
    console.error(
      "WARNING: NIM response was truncated (finish_reason=length) — some postings/links may be missing from this alert. Consider raising max_tokens further."
    );
  }
  return choice?.message?.content?.trim() || "(no summary generated)";
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

  const allOffers = parsePendingOffers();
  console.log(`New postings found (pre year-filter): ${allOffers.length}`);

  persistState();

  const offers = allOffers.filter(mentionsTargetYear);
  console.log(`New postings mentioning 2027: ${offers.length}`);

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
