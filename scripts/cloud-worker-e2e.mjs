#!/usr/bin/env bun
/**
 * Live end-to-end probe for the cloud translation worker.
 *
 * Creates a tiny 3-part job with one real OpenRouter key, waits for the worker
 * to translate it, and prints the full status/chunk payload shapes. Run with:
 *   bun scripts/cloud-worker-e2e.mjs
 *
 * Env overrides:
 *   WORKER_URL / WORKER_SECRET / OR_KEY
 */

const WORKER_URL =
  process.env.WORKER_URL ?? "https://novel-translator-worker.vicente-translator.workers.dev";
const WORKER_SECRET = process.env.WORKER_SECRET ?? "3ad7c4d2df5fdac8868be559294a8913";
const OR_KEY =
  process.env.OR_KEY ?? "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";

const SRC = [
  "Paragraph one of the test chunk. 这是一段简单的中文测试文本。",
  "Paragraph two. 这段文字需要被翻译成英文。",
  "Paragraph three. 翻译完成后，Worker 会把结果存入队列。",
];

function authHeaders(extra = {}) {
  return { "Content-Type": "application/json", "x-job-secret": WORKER_SECRET, ...extra };
}

async function j(path, init = {}) {
  const res = await fetch(`${WORKER_URL}${path}`, init);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text.slice(0, 200); }
  return { status: res.status, body };
}

const { body: ping } = await j("/api/ping", { headers: authHeaders() });
console.log("PING:", JSON.stringify(ping));

const created = await j("/api/jobs", {
  method: "POST",
  headers: authHeaders(),
  body: JSON.stringify({
    fileName: "e2e-probe.txt",
    model: "openrouter/free",
    keys: [OR_KEY],
    chunks: SRC.map((text) => ({ text, gzip: false })),
  }),
});
console.log("CREATE:", JSON.stringify(created));

if (created.status !== 200 || !created.body?.jobId) {
  console.error("Could not create job — stopping.");
  process.exit(1);
}

const jobId = created.body.jobId;
console.log("JOB:", jobId);

const deadline = Date.now() + 180_000;
let lastStatus = null;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 8000));
  const { status, body } = await j(`/api/jobs/${jobId}`, { headers: authHeaders() });
  if (status !== 200) {
    console.log("STATUS ERR:", status, JSON.stringify(body));
    break;
  }
  lastStatus = body;
  console.log(
    `STATUS t=${Math.round((Date.now() - created.body.createdAt ?? Date.now()) / 1000)}s`,
    JSON.stringify({
      status: body.status,
      completed: body.completedChunks,
      total: body.totalChunks,
      failed: body.failedChunks,
      model: body.activeModel,
      heartbeatAge: body.lastHeartbeat ? Date.now() - body.lastHeartbeat : null,
      pauseReason: body.pauseReason ?? null,
    }),
  );
  if (body.status !== "active") break;
}

const { body: chunks } = await j(`/api/jobs/${jobId}/chunks`, { headers: authHeaders() });
const list = Array.isArray(chunks?.chunks) ? chunks.chunks : [];
console.log("CHUNKS:", JSON.stringify(list.map((c) => ({ id: c.id, len: c.text?.length }))));
for (const c of list) console.log(`  chunk ${c.id}: ${(c.text ?? "").slice(0, 120)}`);
console.log("FINAL:", JSON.stringify(lastStatus));

// Cleanup: delete the probe job so the worker does not keep translating it
const del = await j(`/api/jobs/${jobId}`, { method: "DELETE", headers: authHeaders() });
console.log("DELETE:", del.status, JSON.stringify(del.body));
console.log("DONE.");
