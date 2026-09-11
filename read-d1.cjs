// Read-only diagnostics: dump accumulated partial state for the smoke job.
const fs = require("fs");

let raw = "";
for (const f of ["/tmp/d1.json", "d1.json"]) {
  try {
    raw = fs.readFileSync(f, "utf8");
    break;
  } catch {
    /* try next */
  }
}
if (!raw) {
  console.log("no diagnostics file found");
  process.exit(1);
}

const start = raw.indexOf("\n[");
const payload = start >= 0 ? raw.slice(start + 1) : raw;
try {
  const j = JSON.parse(payload);
  const r = j?.[0]?.results?.[0];
  if (!r) {
    console.log("no rows:", payload.slice(0, 400));
  } else {
    console.log("status:", r.status, "| attempts:", r.attempts, "| accumulated chars:", r.acc_chars);
    if (r.head) console.log("HEAD:", r.head);
    if (r.tail) console.log("TAIL:", r.tail);
  }
} catch (e) {
  console.log("parse failed; raw head:");
  console.log(raw.slice(0, 600));
}
