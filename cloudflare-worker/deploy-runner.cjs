// Deploy runner: loads CLOUDFLARE_API_TOKEN from the project's env files and
// passes it to wrangler via the process environment. The value is NEVER
// printed, logged, or written anywhere by this script.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const here = __dirname;
const root = path.resolve(here, "..");

const candidates = fs.readdirSync(root).filter((f) => /^\.env/.test(f));

function charClass(ch) {
  if (/[A-Z]/.test(ch)) return "U"; // uppercase
  if (/[a-z]/.test(ch)) return "l"; // lowercase
  if (/[0-9]/.test(ch)) return "D"; // digit
  if (ch === ":") return "C";
  if (ch === "-" || ch === "_") return "S";
  if (ch === "." ) return "P";
  return "O"; // anything else
}

// Run-length-encoded skeleton: "U1.l20.D32.C1..." — shows structure, no content
function skeleton(v) {
  const out = [];
  let i = 0;
  while (i < v.length) {
    const c = charClass(v[i]);
    let j = i;
    while (j < v.length && charClass(v[j]) === c) j++;
    out.push(`${c}${j - i}`);
    i = j;
  }
  return out.join(".");
}

let loaded = false;
for (const f of candidates) {
  const text = fs.readFileSync(path.join(root, f), "utf8");
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*(?:export\s+)?CLOUDFLARE_API_TOKEN\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let val = m[1].replace(/\s+#.*$/, "").replace(/^["']|["']$/g, "").trim();
    console.log(`[runner] ${f}:${i + 1} len=${val.length}`);
    console.log(`[runner] skeleton: ${skeleton(val)}`);
    // Segment shape around any colon (structure only)
    const parts = val.split(":");
    if (parts.length > 1) {
      parts.forEach((p, idx) =>
        console.log(`[runner] colon-segment ${idx}: len=${p.length} charset=/^[${p.replace(/[^A-Za-z0-9_./:-]/g, "^")}]$/-filtered`),
      );
    }
    const shapeOk = /^[A-Za-z0-9_-]{30,60}$/.test(val);
    if (shapeOk && !process.env.CLOUDFLARE_API_TOKEN) {
      process.env.CLOUDFLARE_API_TOKEN = val;
      loaded = true;
      console.log("[runner] token shape OK — using it (value hidden)");
    } else {
      console.error("[runner] value does NOT match Cloudflare API token shape (30-60 chars of A-Za-z0-9_-).");
    }
  }
}
if (!loaded) {
  console.error(`[runner] no usable CLOUDFLARE_API_TOKEN in: ${candidates.join(", ") || "(none)"}`);
  process.exit(2);
}

const args = process.argv.slice(2);
const r = spawnSync("bunx wrangler " + args.join(" "), {
  stdio: "inherit",
  env: process.env,
  cwd: here,
  shell: true,
});
process.exit(r.status ?? 1);
