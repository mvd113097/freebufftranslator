// Polls the smoke job until done/failed/cancelled, printing one line per tick.
const JOB = process.argv[2];
const MAX_TICKS = parseInt(process.argv[3] ?? "14", 10);
const W = "https://novel-translator-worker.vicente-translator.workers.dev";
const SECRET = "3ad7c4d2df5fdac8868be559294a8913";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  for (let i = 0; i < MAX_TICKS; i++) {
    const res = await fetch(`${W}/api/jobs/${JOB}`, {
      headers: { "x-job-secret": SECRET },
    });
    const j = await res.json();
    console.log(
      `t+${i * 30}s status=${j.status} completed=${j.completedChunks} partial=${j.partialChunks} failed=${j.failedChunks} blocked=${j.blockedChunks} heartbeatAge=${j.lastHeartbeat ? Date.now() - j.lastHeartbeat : "?"}ms`,
    );
    if (["done", "failed", "cancelled"].includes(j.status)) {
      console.log("FINAL:", JSON.stringify(j));
      return;
    }
    await sleep(25000);
  }
  console.log("TIMEOUT: still active after", MAX_TICKS * 30, "s");
}
main().catch((e) => {
  console.error("POLL ERROR:", e?.message ?? e);
  process.exit(1);
});
