// One scan "leg" — either the curated scan.mjs watchlist, or a single ATS
// source for scan-ats-full.mjs (--ats greenhouse|lever|ashby|workday|icims).
// Runs in its own matrix job so the 5 ATS sources scan in parallel instead
// of one process working through them sequentially. Writes its findings +
// its own state delta to ./leg-output/ for the aggregate job to merge.
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

const ROOT = process.cwd();
const SRC_DIR = path.join(ROOT, "career-ops-src");
const STATE_DIR = path.join(ROOT, "state");
const CONFIG_DIR = path.join(ROOT, "config");
const LEG = process.argv[2]; // "curated" or an ATS name e.g. "greenhouse"
const OUT_DIR = path.join(ROOT, "leg-output", LEG);

// Full-coverage-per-leg limit. Parallelizing 5 ATS sources across 5 matrix
// jobs means each only needs to cover its own slice, so this can be much
// higher than a single-process run could afford in the same wall-clock time.
const PER_LEG_LIMIT = 2500;

const PIPELINE_SKELETON = `# Pipeline\n\n## Pending\n\n## Processed\n`;

function sh(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
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
  writeFileSync(path.join(dataDir, "pipeline.md"), PIPELINE_SKELETON);
}

function runScan() {
  if (LEG === "curated") {
    sh("node", ["scan.mjs"], { cwd: SRC_DIR });
  } else {
    sh(
      "node",
      [
        "scan-ats-full.mjs",
        "--ats",
        LEG,
        "--since",
        "1",
        "--limit",
        String(PER_LEG_LIMIT),
      ],
      { cwd: SRC_DIR }
    );
  }
}

function parsePendingOffers() {
  const pipelinePath = path.join(SRC_DIR, "data", "pipeline.md");
  if (!existsSync(pipelinePath)) return [];
  const text = readFileSync(pipelinePath, "utf8");
  const lines = text.split("\n").filter((l) => l.startsWith("- [ ] "));
  return lines.map((line) => {
    const body = line.slice("- [ ] ".length);
    const parts = body.split(" | ").map((p) => p.trim());
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

function saveLegOutput(offers) {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    path.join(OUT_DIR, "offers.json"),
    JSON.stringify(offers, null, 2)
  );
  const dataDir = path.join(SRC_DIR, "data");
  for (const f of ["scan-history.tsv", "portal-health.tsv"]) {
    const src = path.join(dataDir, f);
    if (existsSync(src)) cpSync(src, path.join(OUT_DIR, f));
  }
  const cacheSrc = path.join(dataDir, "cache");
  if (existsSync(cacheSrc)) {
    cpSync(cacheSrc, path.join(OUT_DIR, "cache"), { recursive: true });
  }
}

function main() {
  if (!LEG) {
    console.error("Usage: node scan-leg.mjs <curated|greenhouse|lever|ashby|workday|icims>");
    process.exit(1);
  }
  setupSrc();
  restoreState();
  try {
    runScan();
  } catch (e) {
    console.error(`Leg ${LEG} scan failed (continuing, leg contributes 0 offers):`, e.message);
  }
  const offers = parsePendingOffers();
  console.log(`Leg ${LEG}: ${offers.length} offers found`);
  saveLegOutput(offers);
}

main();
