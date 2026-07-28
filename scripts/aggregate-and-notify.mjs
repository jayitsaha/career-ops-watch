// Merges all scan-leg outputs (leg-output/<leg>/...), applies the hard
// USA/2027 gate, summarizes relevance in parallel batches across a pool of
// NVIDIA NIM keys (round-robin), and sends one Telegram report. Also merges
// each leg's state delta (scan-history.tsv/portal-health.tsv/cache) into a
// single state/ directory for the workflow to commit.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, cpSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const LEG_OUTPUT_DIR = path.join(ROOT, "leg-output");
const STATE_DIR = path.join(ROOT, "state");

const NIM_KEYS = (process.env.NIM_API_KEYS || process.env.NIM_API_KEY || "")
  .split(",")
  .map((k) => k.trim())
  .filter(Boolean);
const NIM_MODEL = process.env.NIM_MODEL || "meta/llama-3.1-70b-instruct";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const CHUNK_SIZE = 25; // postings per NIM call

const USER_PROFILE = `Incoming Georgia Tech MS in Computer Science student, specializing in Machine
Learning. Wants ONLY Summer 2027 internships, USA-based, in these tracks:
(1) Data Scientist / Applied Data Scientist / Research Data Scientist,
(2) Software Engineer / SWE (including close variants: ML Engineer, Platform
Engineer intern roles), (3) Applied Scientist / Research Scientist / GenAI /
LLM / Agentic / RAG / Generative AI roles, (4) Quantitative Research (quant
research intern/researcher) AND Quantitative Trading (quant trader,
quantitative analyst, quant developer). Consider multiple phrasings/synonyms
per track when judging relevance, not just exact title matches.`;

function mentionsTargetYear(offer) {
  const text = `${offer.title} ${offer.company}`.toLowerCase();
  return text.includes("2027");
}

function loadAllLegOffers() {
  if (!existsSync(LEG_OUTPUT_DIR)) return [];
  const legs = readdirSync(LEG_OUTPUT_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  const seen = new Set();
  const merged = [];
  for (const leg of legs) {
    const offersPath = path.join(LEG_OUTPUT_DIR, leg, "offers.json");
    if (!existsSync(offersPath)) continue;
    const offers = JSON.parse(readFileSync(offersPath, "utf8"));
    for (const o of offers) {
      if (!o.url || seen.has(o.url)) continue; // cross-leg dedup by URL
      seen.add(o.url);
      merged.push(o);
    }
  }
  console.log(`Merged ${merged.length} unique offers across ${legs.length} legs: ${legs.join(", ")}`);
  return merged;
}

function mergeState() {
  mkdirSync(STATE_DIR, { recursive: true });
  if (!existsSync(LEG_OUTPUT_DIR)) return;
  const legs = readdirSync(LEG_OUTPUT_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  // scan-history.tsv: union of rows across legs, deduped by URL (1st column).
  const historyRows = new Map(); // url -> full row
  for (const leg of legs) {
    const p = path.join(LEG_OUTPUT_DIR, leg, "scan-history.tsv");
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const url = line.split("\t")[0];
      if (!historyRows.has(url)) historyRows.set(url, line);
    }
  }
  if (historyRows.size) {
    writeFileSync(
      path.join(STATE_DIR, "scan-history.tsv"),
      [...historyRows.values()].join("\n") + "\n"
    );
  }

  // portal-health.tsv: low-stakes, last leg wins.
  for (const leg of legs) {
    const p = path.join(LEG_OUTPUT_DIR, leg, "portal-health.tsv");
    if (existsSync(p)) cpSync(p, path.join(STATE_DIR, "portal-health.tsv"));
  }

  // cache/: overlay all legs' caches together (per-ATS subfolders don't collide).
  for (const leg of legs) {
    const p = path.join(LEG_OUTPUT_DIR, leg, "cache");
    if (existsSync(p)) cpSync(p, path.join(STATE_DIR, "cache"), { recursive: true });
  }
}

async function summarizeChunk(items, apiKey) {
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
        content: `${USER_PROFILE}
Judge each posting below. Respond with ONLY a raw JSON array (no prose, no markdown fences),
one object per posting IN THE SAME ORDER given, each with exactly these fields:
{"relevant": boolean, "tier": "high"|"medium", "why": "<short clause>", "action": "<one concrete next step>"}
Drop nothing from the array — return one object per input line even if relevant=false.`,
      },
      { role: "user", content: listText },
    ],
    temperature: 0.2,
    max_tokens: 4000,
  };

  const res = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
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
    console.error(`WARNING: NIM chunk response truncated (finish_reason=length) — judgments may be missing for this chunk.`);
  }
  const raw = choice?.message?.content?.trim() || "[]";
  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  let judgments;
  try {
    judgments = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
  } catch (e) {
    console.error("Failed to parse NIM chunk JSON, treating chunk as all non-relevant:", e.message, "\nRaw:", raw.slice(0, 500));
    judgments = items.map(() => ({ relevant: false }));
  }
  return items.map((item, idx) => ({
    ...item,
    ...(judgments[idx] || { relevant: false }),
  }));
}

async function summarizeAll(offers) {
  if (NIM_KEYS.length === 0) throw new Error("No NIM_API_KEYS/NIM_API_KEY configured");

  const chunks = [];
  for (let i = 0; i < offers.length; i += CHUNK_SIZE) {
    chunks.push(offers.slice(i, i + CHUNK_SIZE));
  }
  console.log(`Summarizing ${offers.length} offers in ${chunks.length} chunk(s) across ${NIM_KEYS.length} key(s)`);

  const results = await Promise.all(
    chunks.map((chunk, idx) => summarizeChunk(chunk, NIM_KEYS[idx % NIM_KEYS.length]))
  );
  return results.flat();
}

function formatReport(judged) {
  const relevant = judged.filter((j) => j.relevant);
  const high = relevant.filter((j) => j.tier === "high");
  const medium = relevant.filter((j) => j.tier !== "high");

  const formatItem = (j) =>
    `${j.company} — ${j.title} (${j.location})\nApply: ${j.url}${
      j.compensation ? `\nComp: ${j.compensation}` : ""
    }\nWhy: ${j.why || "n/a"}\nAction: ${j.action || "Review and apply if interested"}`;

  const sections = [];
  if (high.length) sections.push(`🔥 High\n\n${high.map(formatItem).join("\n\n")}`);
  if (medium.length) sections.push(`🟡 Medium\n\n${medium.map(formatItem).join("\n\n")}`);
  return sections.join("\n\n");
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
  mergeState();

  const allOffers = loadAllLegOffers();
  const offers = allOffers.filter(mentionsTargetYear);
  console.log(`${allOffers.length} total new offers, ${offers.length} mention 2027`);

  if (offers.length === 0) {
    console.log("No changes — nothing to notify.");
    return;
  }

  const judged = await summarizeAll(offers);
  const relevantCount = judged.filter((j) => j.relevant).length;
  console.log(`${relevantCount} of ${offers.length} judged relevant`);

  if (relevantCount === 0) {
    console.log("None judged relevant — nothing to notify.");
    return;
  }

  const report = formatReport(judged);
  console.log("--- Report ---\n" + report);

  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    await sendTelegram(
      `[career-ops scan] ${relevantCount} relevant of ${offers.length} new postings mentioning 2027:\n\n${report}`
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
