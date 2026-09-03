/**
 * Tiny helper used before uploading a translation file: each chunk is gzipped
 * on the phone so far fewer bytes cross the network (~40-50% smaller for
 * Chinese web novels). If the browser doesn't support CompressionStream, the
 * plain text is sent instead and the server never tries to decompress it.
 */

export interface UploadChunk {
  /** Either the gzipped+base64 text (gzip=true) or the plain text (gzip=false). */
  text: string;
  /** Character length of the ORIGINAL plain text (used for job stats). */
  len: number;
  /** Whether `text` is gzip-compressed base64. */
  gzip: boolean;
}

/** Gzip a text chunk to base64. Throws if compression is unavailable/fails. */
async function gzipToBase64(text: string): Promise<string> {
  if (typeof CompressionStream === "undefined" || typeof Blob === "undefined") {
    throw new Error("CompressionStream not supported");
  }
  const stream = new Blob([text]).stream().pipeThrough(
    new CompressionStream("gzip")
  );
  const buffer = await new Response(stream).arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const STEP = 0x8000; // avoid call-stack overflow on large buffers
  for (let i = 0; i < bytes.length; i += STEP) {
    binary += String.fromCharCode(...bytes.subarray(i, i + STEP));
  }
  return btoa(binary);
}

/**
 * Prepare a chunk for upload: compress when possible, otherwise pass the
 * plain text through. Never throws — the caller can always proceed.
 */
export async function prepareChunkForUpload(text: string): Promise<UploadChunk> {
  if (text.length === 0) return { text, len: 0, gzip: false };
  try {
    return { text: await gzipToBase64(text), len: text.length, gzip: true };
  } catch {
    return { text, len: text.length, gzip: false };
  }
}

/** Estimate of how many bytes a chunk will occupy after upload (for UI hints). */
export function uploadBytesEstimate(chunks: UploadChunk[]): number {
  return chunks.reduce((sum, c) => sum + c.text.length, 0);
}
