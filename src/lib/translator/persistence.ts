/**
 * Persistence layer for surviving browser reloads mid-translation.
 *
 * - localStorage: API keys, model, chunk size, concurrency settings
 * - IndexedDB: text chunks, their completion status, and translated text
 */

import { openDB, type IDBPDatabase } from "idb";

// ─── localStorage helpers ──────────────────────────────────────────

const SETTINGS_KEY = "novel-translator-settings";

export interface AppSettings {
  keys: string[];
  model: string;
  chunkSize: number;
  concurrency: number;
}

const DEFAULT_SETTINGS: AppSettings = {
  keys: [],
  model: "openrouter/free",
  chunkSize: 4000,
  concurrency: 5,
};

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* quota exceeded — silently ignore */
  }
}

// ─── IndexedDB chunk storage ───────────────────────────────────────

const DB_NAME = "novel-translator";
const DB_VERSION = 1;
const CHUNKS_STORE = "chunks";
const SESSION_STORE = "session";

export interface StoredChunk {
  id: number;
  text: string;
  status: "pending" | "completed";
  translatedText: string;
}

export interface StoredSession {
  id: string;
  fileName: string;
  rawTextLength: number;
  totalChunks: number;
  createdAt: number;
  updatedAt: number;
}

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(CHUNKS_STORE)) {
          db.createObjectStore(CHUNKS_STORE, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(SESSION_STORE)) {
          db.createObjectStore(SESSION_STORE, { keyPath: "id" });
        }
      },
    });
  }
  return dbPromise;
}

/**
 * Save the full chunk list and session metadata.
 * Called once when a file is first uploaded.
 */
export async function saveSession(
  session: StoredSession,
  chunks: StoredChunk[],
): Promise<void> {
  const db = await getDb();
  const tx = db.transaction([CHUNKS_STORE, SESSION_STORE], "readwrite");
  await tx.objectStore(SESSION_STORE).put(session);
  const chunkStore = tx.objectStore(CHUNKS_STORE);
  for (const chunk of chunks) {
    await chunkStore.put(chunk);
  }
  await tx.done;
}

/**
 * Load the saved session and its chunks.
 * Returns null if no session exists.
 */
export async function loadSession(): Promise<{
  session: StoredSession;
  chunks: StoredChunk[];
} | null> {
  const db = await getDb();
  const session = await db.get(SESSION_STORE, "current");
  if (!session) return null;
  const chunks = await db.getAll(CHUNKS_STORE);
  if (chunks.length === 0) return null;
  return { session, chunks };
}

/**
 * Update a single chunk's status and translated text.
 * Called as each chunk completes.
 */
export async function updateChunk(chunk: StoredChunk): Promise<void> {
  const db = await getDb();
  await db.put(CHUNKS_STORE, chunk);
}

/**
 * Clear all stored chunks and session data.
 * Called after successful download or on "Start Over".
 */
export async function clearSession(): Promise<void> {
  const db = await getDb();
  const tx = db.transaction([CHUNKS_STORE, SESSION_STORE], "readwrite");
  await tx.objectStore(CHUNKS_STORE).clear();
  await tx.objectStore(SESSION_STORE).clear();
  await tx.done;
}
