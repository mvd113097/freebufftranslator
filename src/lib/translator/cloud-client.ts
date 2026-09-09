/**
 * Browser client for the Cloudflare translation worker.
 *
 * The worker owns a D1 queue and translates chunks on a 5-minute cron, so the
 * browser can be closed while a big novel translates. This client just:
 *   1. creates a job (uploads the chunk source texts),
 *   2. polls status,
 *   3. downloads the finished chunks for .epub export.
 *
 * The worker URL + shared secret are stored in localStorage (per-device), so
 * they're easy to point at a freshly-deployed worker without touching .env.
 */

const WORKER_URL_KEY = "novel-translator-worker-url";
const WORKER_SECRET_KEY = "novel-translator-worker-secret";

export function getWorkerUrl(): string {
  try {
    return localStorage.getItem(WORKER_URL_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setWorkerUrl(url: string): void {
  try {
    localStorage.setItem(WORKER_URL_KEY, url.trim().replace(/\/+$/, ""));
  } catch {
    /* ignore */
  }
}

export function getWorkerSecret(): string {
  try {
    return localStorage.getItem(WORKER_SECRET_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setWorkerSecret(secret: string): void {
  try {
    localStorage.setItem(WORKER_SECRET_KEY, secret.trim());
  } catch {
    /* ignore */
  }
}

export interface CloudJobStatus {
  jobId: string;
  fileName: string;
  status: "active" | "done" | "cancelled" | "paused";
  totalChunks: number;
  completedChunks: number;
  failedChunks: number;
  activeModel: string | null;
  createdAt: number;
  lastHeartbeat: number | null;
  lastChunkAt: number | null;
  updatedAt: number;
  pauseReason: string | null;
}

async function request(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = getWorkerUrl();
  const secret = getWorkerSecret();
  if (!url) throw new Error("Cloud worker URL not configured. Add it in Settings.");
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  if (secret) headers.set("x-job-secret", secret);
  const res = await fetch(`${url}${path}`, { ...init, headers });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      if (data?.error) msg = data.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return res;
}

/** Test the worker is reachable and the secret is correct. */
export async function pingWorker(): Promise<{ ok: boolean; time: number }> {
  const url = getWorkerUrl();
  if (!url) throw new Error("Cloud worker URL not configured.");
  const secret = getWorkerSecret();
  const res = await fetch(`${url}/api/ping`, {
    headers: secret ? { "x-job-secret": secret } : undefined,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      if (data?.error) msg = data.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return res.json();
}

export interface CreateJobInput {
  fileName: string;
  model: string;
  keys: string[];
  chunks: { text: string }[];
  /** Quality-ranked live model slugs. Worker uses this for the auto-free cascade. */
  liveModels?: string[];
  telegramBotToken?: string;
  telegramChatId?: string;
  telegramNotifyOnStart?: boolean;
  telegramNotifyOnProgress?: boolean;
  telegramNotifyOnError?: boolean;
  telegramNotifyOnComplete?: boolean;
}

export async function createCloudJob(
  input: CreateJobInput,
): Promise<{ jobId: string; totalChunks: number }> {
  const res = await request("/api/jobs", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return res.json();
}

export async function getCloudStatus(jobId: string): Promise<CloudJobStatus> {
  const res = await request(`/api/jobs/${jobId}`);
  return res.json();
}

export async function getCloudChunks(
  jobId: string,
  after = -1,
): Promise<{ id: number; text: string }[]> {
  const res = await request(`/api/jobs/${jobId}/chunks?after=${after}`);
  const data = await res.json();
  return data.chunks ?? [];
}

export async function cancelCloudJob(jobId: string): Promise<void> {
  await request(`/api/jobs/${jobId}/cancel`, { method: "POST" });
}

export async function deleteCloudJob(jobId: string): Promise<void> {
  await request(`/api/jobs/${jobId}`, { method: "DELETE" });
}
