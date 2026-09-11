// Deploy runner: loads CLOUDFLARE_API_TOKEN from .cf-token.tmp (preferred) or
// project env files, then runs wrangler. Values are NEVER printed or logged.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const here = __dirname;
const root = path.resolve(here, "..");

process.env.CLOUDFLARE_API_TOKEN = "";

// Preferred: temp token file (out-of-band paste, deleted after deploy).
const tokenFile = path.join(here, ".cf-token.tmp");
if (fs.existsSync(tokenFile)) {
  const val = fs.readFileSync(tokenFile, "utf8").trim();
  if (/^[A-Za-z0-9_-]{20,80}$/.test(val)) {
    process.env.CLOUDFLARE_API_TOKEN = val;
    console.log("[runner] token loaded from .cf-token.tmp (value hidden)");
  } else {
    console.error("[runner] .cf-token.tmp has invalid shape — ignoring");
  }
}

// Fallback: project env files (values there are platform-encrypted and won't
// validate, but try anyway in case a raw token was ever stored).
if (!process.env.CLOUDFLARE_API_TOKEN) {
  const envFiles = fs.readdirSync(root).filter((f) => /^\.env/.test(f));
  for (const f of envFiles) {
    const text = fs.readFileSync(path.join(root, f), "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?CLOUDFLARE_API_TOKEN\s*=\s*(.+?)\s*$/);
      if (!m) continue;
      const val = m[1].replace(/\s+#.*$/, "").replace(/^["']|["']$/g, "").trim();
      if (/^[A-Za-z0-9_-]{20,80}$/.test(val)) {
        process.env.CLOUDFLARE_API_TOKEN = val;
        console.log(`[runner] token loaded from ${f} (value hidden)`);
        break;
      }
    }
    if (process.env.CLOUDFLARE_API_TOKEN) break;
  }
}

if (!process.env.CLOUDFLARE_API_TOKEN) {
  console.error("[runner] no usable CLOUDFLARE_API_TOKEN found");
  process.exit(2);
}

const args = process.argv.slice(2);
// Shell-escape each arg (single-quote wrapping) so SQL with parens/quotes
// survives the intermediate /bin/sh hop intact.
const escaped = args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
const r = spawnSync("bunx wrangler " + escaped, {
  stdio: "inherit",
  env: process.env,
  cwd: here,
  shell: true,
});
process.exit(r.status ?? 1);
