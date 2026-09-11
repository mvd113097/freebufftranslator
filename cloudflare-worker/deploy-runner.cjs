// Deploy runner: loads CLOUDFLARE_API_TOKEN from the project's env files and
// passes it to wrangler via the process environment. The value is NEVER
// printed, logged, or written anywhere by this script.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const here = __dirname;
const root = path.resolve(here, "..");

const candidates = fs.readdirSync(root).filter((f) => /^\.env/.test(f));

let loaded = false;
for (const f of candidates) {
  const text = fs.readFileSync(path.join(root, f), "utf8");
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*(?:export\s+)?CLOUDFLARE_API_TOKEN\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let val = m[1].replace(/\s+#.*$/, "").replace(/^["']|["']$/g, "").trim();
    // Class breakdown only — reveals structure, never content
    const classes = {
      letters: (val.match(/[A-Za-z]/g) ?? []).length,
      digits: (val.match(/[0-9]/g) ?? []).length,
      dots: (val.match(/\./g) ?? []).length,
      colons: (val.match(/:/g) ?? []).length,
      equals: (val.match(/=/g) ?? []).length,
      braces: (val.match(/[{}[\]]/g) ?? []).length,
      quotesInside: (val.match(/["']/g) ?? []).length,
      underscoresDashes: (val.match(/[_-]/g) ?? []).length,
      other: (val.match(/[^A-Za-z0-9._:=(){}[\]"'-]/g) ?? []).length,
    };
    const startsLetter = /^[A-Za-z]/.test(val);
    const looksJwt = classes.dots === 2 && classes.letters > 100;
    const looksJson = classes.braces > 0 && classes.colons > 0;
    console.log(
      `[runner] ${f}:${i + 1} len=${val.length} startsWithLetter=${startsLetter} ` +
        `letters=${classes.letters} digits=${classes.digits} dots=${classes.dots} colons=${classes.colons} ` +
        `equals=${classes.equals} braces=${classes.braces} innerQuotes=${classes.quotesInside} other=${classes.other} ` +
        `| shape: ${looksJwt ? "JWT-like" : looksJson ? "JSON-like" : "opaque"}`,
    );
    // Only pass through a value shaped like a real CF token
    const shapeOk = /^[A-Za-z0-9_-]{30,60}$/.test(val);
    if (shapeOk && !process.env.CLOUDFLARE_API_TOKEN) {
      process.env.CLOUDFLARE_API_TOKEN = val;
      loaded = true;
      console.log("[runner] token shape OK — using it (value hidden)");
    } else {
      console.error(
        "[runner] value does NOT have Cloudflare API token shape (expected 30-60 chars of A-Za-z0-9_-). " +
          "Please re-add a bare API token in the Keys UI (no JSON, no JWT, no quotes).",
      );
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
