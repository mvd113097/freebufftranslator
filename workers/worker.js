// Gemini translation worker for Cloudflare Workers
// Handles both OpenRouter and Gemini API translation

const SYSTEM_PROMPT = `You are an expert human literary translator specializing in Chinese web novels (Xianxia, Wuxia, and Sci-Fi). Translate the following Chinese prose into highly fluent, immersive English fiction. Do not use stiff or literal machine-like phrasing. Translate cultivation tiers, localized idioms, and online slang into contextually accurate Western fantasy equivalents while maintaining rigid character name consistency.

## FORMATTING RULES (VERY IMPORTANT - FOLLOW EXACTLY):

You MUST separate EVERY paragraph with a BLANK LINE. This means each paragraph ends with TWO newline characters (\n\n). This is non-negotiable.

Example of CORRECT formatting:
Paragraph one text here.

Paragraph two text here.

Paragraph three text here.

- Count the paragraphs in the input. Your output MUST have the SAME number of paragraphs.
- Each paragraph in the input becomes exactly ONE paragraph in the output, separated by a blank line.
- Preserve dialogue formatting and paragraph indentation style.
- Do NOT merge paragraphs together.
- Do NOT output everything as one continuous block of text.

## OUTPUT RULES:
- Output ONLY the translated English text.
- Do NOT include any explanations, notes, commentary, or metadata.
- Do NOT wrap your output in quotes or markdown code blocks.
- Just return the raw translated English prose with proper paragraph spacing (blank lines between paragraphs).
- CRITICAL: Do NOT leave ANY Chinese characters untranslated. Every single Chinese word, phrase, and sentence MUST be translated to English.`;

// OpenRouter free-tier models
const OPENROUTER_FREE_MODELS = [
  "inclusionai/ling-3.0-flash-fin:free",
  "inclusionai/ling-3.0-flash-sante:free",
  "google/gemma-4-31b-it:free",
  "google/gemma-4-26b-a4b-it:free",
  "poolside/laguna-s-2.1:free",
  "poolside/laguna-xs-2.1:free",
  "nex-agi/nex-n2.5-pro:free",
  "nex-agi/nex-n2.5-mini:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "thinkingmachines/inkling:free",
  "nvidia/nemotron-3.5-lightning:free",
  "thinkingmachines/inkling-small:free",
  "dots-studio/dots-3-note-preview:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "liquid/lfm-2.5-2.6b:free"
];

// Gemini models from Google's official API docs
const GEMINI_MODELS = [
  "gemini-3.8-flash",
  "gemini-3.7-flash", 
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite"
];

// Chunk splitting for worker - allow larger chunks to respect user's quota settings
// User's pipeline uses 100k chars/chunk, worker should respect that
const BATCH_SIZE = 1;
const MAX_RETRIES = 3;
const STAGGER_MS = 4500;
const MAX_TOKENS = 16000;
const UPSTREAM_TIMEOUT_MS = 110000;
const CASCADE_STATUSES = new Set([402, 404, 408, 429, 500, 502, 503, 504]);

// Maximum characters per API request to Gemini (increase from 5000 to allow larger chunks)
// Gemini 3.5/3.6 Flash can handle much larger inputs
const MAX_CHARS_PER_REQUEST = 50000; // 50k chars per request - balances quota vs timeout risk
const MIN_CHARS_PER_REQUEST = 5000; // minimum if splitting is needed

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,x-job-secret"
    }
  });
}

function cors() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,x-job-secret"
    }
  });
}

function verifySecret(request, env) {
  if (!env.JOB_SECRET) return true;
  const provided = request.headers.get("x-job-secret") ?? "";
  return provided === env.JOB_SECRET;
}

// Split text into manageable chunks for API requests
// Respects user's pipeline chunk size while avoiding worker timeouts
function splitIntoApiChunks(text, maxChars = MAX_CHARS_PER_REQUEST) {
  if (text.length <= maxChars) {
    return [text];
  }
  
  const chunks = [];
  let remaining = text;
  
  while (remaining.length > 0) {
    if (remaining.length <= maxChars) {
      chunks.push(remaining);
      break;
    }
    
    // Try to split at a paragraph boundary (double newline) for better quality
    let splitPoint = remaining.lastIndexOf('\n\n', maxChars);
    if (splitPoint === -1 || splitPoint < MIN_CHARS_PER_REQUEST) {
      // No good paragraph boundary, split at maxChars
      splitPoint = maxChars;
      // Try to find a sentence boundary near the split point
      const nearSplit = remaining.lastIndexOf('.', splitPoint + 50);
      if (nearSplit > maxChars - 100) {
        splitPoint = nearSplit + 1;
      }
    }
    
    chunks.push(remaining.slice(0, splitPoint));
    remaining = remaining.slice(splitPoint).trimStart();
  }
  
  return chunks;
}

async function decompressGzip(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++)
    bytes[i] = binary.charCodeAt(i);
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const reader = ds.readable.getReader();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const totalLen = chunks.reduce((s, c) => s + c.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) {
    result.set(c, offset);
    offset += c.length;
  }
  return new TextDecoder().decode(result);
}

async function sendTelegram(botToken, chatId, message) {
  if (!botToken || !chatId) return;
  const targets = chatId.split(",").map((s) => s.trim()).filter(Boolean);
  await Promise.all(
    targets.map(
      (id) => fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: id,
          text: message,
          parse_mode: "HTML",
          disable_web_page_preview: true
        })
      }).catch(() => void 0)
    )
  );
}

function resolveModel(requested) {
  if (requested === "openrouter/free" || requested === "openrouter/auto" || requested === "auto") {
    return OPENROUTER_FREE_MODELS[0];
  }
  if (requested === "gemini/free") {
    return GEMINI_MODELS[0];
  }
  return requested;
}

async function callOpenRouter(text, key, model, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://novel-translator.app",
        "X-Title": "Novel Translator"
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: text }
        ],
        max_tokens: MAX_TOKENS,
        temperature: 0.3
      }),
      signal: controller.signal
    });
    if (res.status === 429) throw new Error("RATE_LIMITED");
    if (CASCADE_STATUSES.has(res.status)) {
      throw new Error(`Model ${model} unavailable (HTTP ${res.status})`);
    }
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${errBody.slice(0, 300)}`);
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error("Empty response from model");
    return { content: content.trim(), model };
  } finally {
    clearTimeout(timer);
  }
}

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

async function callGemini(text, key, model, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(
      `${GEMINI_BASE}/${model}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": key
        },
        body: JSON.stringify({
          contents: [
            { role: "user", parts: [{ text }] }
          ],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: MAX_TOKENS
          },
          systemInstruction: {
            parts: [{ text: SYSTEM_PROMPT }]
          }
        }),
        signal: controller.signal
      }
    );
    
    if (res.status === 429) throw new Error("RATE_LIMITED");
    
    const resText = await res.text().catch(() => "");
    
    // Log the response for debugging
    console.log(`Gemini ${model} with key …${key.slice(-4)}: HTTP ${res.status}`);
    
    if (CASCADE_STATUSES.has(res.status)) {
      throw new Error(`Model ${model} unavailable (HTTP ${res.status})`);
    }
    
    if (!res.ok) {
      const low = resText.toLowerCase();
      if (res.status === 401 || res.status === 403 || /api[ _-]?key|invalid|expired|unauthorized|credential|permission|forbidden|denied|authentication|access denied|no access/i.test(low)) {
        throw new Error(
          `KEY_REJECTED (key …${key.slice(-4)}): ${resText.slice(0, 200) || "Invalid or expired API key"}`
        );
      }
      throw new Error(`HTTP ${res.status}: ${resText.slice(0, 300)}`);
    }
    
    const data = JSON.parse(resText);
    if (data.error) {
      throw new Error(`MODEL_ERROR: ${data.error.message?.slice(0, 200) || "unknown"}`);
    }
    const content = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!content) throw new Error("Empty response from model");
    return { content, model };
  } finally {
    clearTimeout(timer);
  }
}

function isGeminiModel(model) {
  return model.startsWith("gemini-");
}

async function translateChunk(text, keys, requestedModel, liveModels) {
  if (!keys.length) throw new Error("No API keys provided");
  
  const gemini = isGeminiModel(requestedModel);
  let models;
  
  if (gemini) {
    models = [requestedModel, ...GEMINI_MODELS.filter(m => m !== requestedModel)];
  } else if (requestedModel === "openrouter/free" || requestedModel === "openrouter/auto" || requestedModel === "auto") {
    models = liveModels && liveModels.length > 0 
      ? liveModels 
      : OPENROUTER_FREE_MODELS;
  } else {
    models = [requestedModel, ...OPENROUTER_FREE_MODELS.filter(m => m !== requestedModel)];
  }
  
  // Split text into API-sized chunks if needed (respects user's pipeline chunk size)
  const apiChunks = splitIntoApiChunks(text);
  
  let lastError = null;
  let allRateLimited = true;
  let allTranslated = [];
  
  for (let chunkIdx = 0; chunkIdx < apiChunks.length; chunkIdx++) {
    const chunkText = apiChunks[chunkIdx];
    let chunkTranslated = false;
    
    for (const model of models) {
      const backend = isGeminiModel(model) ? callGemini : callOpenRouter;
      
      for (let ki = 0; ki < keys.length; ki++) {
        const key = keys[ki];
        try {
          const result = await backend(chunkText, key, model);
          allTranslated.push(result.content);
          chunkTranslated = true;
          
          // Update active model for tracking
          // (model tracking would go here if needed)
          break;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          
          if (lastError.message === "RATE_LIMITED") {
            continue;
          }
          
          allRateLimited = false;
          
          if (lastError.message.includes("unavailable") || lastError.message.includes("KEY_REJECTED")) {
            break;
          }
          
          break;
        }
      }
      
      if (chunkTranslated) break;
    }
    
    if (!chunkTranslated) {
      // If we couldn't translate this sub-chunk, throw the last error
      if (allRateLimited && lastError?.message === "RATE_LIMITED") {
        throw new Error("QUOTA_EXHAUSTED");
      }
      throw lastError ?? new Error(`Failed to translate sub-chunk ${chunkIdx + 1}/${apiChunks.length}`);
    }
    
    // Add small delay between sub-chunks to avoid overwhelming the API
    if (chunkIdx < apiChunks.length - 1) {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  
  // Combine all translated sub-chunks
  return { 
    translated: allTranslated.join('\n\n'), 
    model: requestedModel 
  };
}

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  
  if (method === "OPTIONS") return cors();
  
  if (path === "/api/ping" && method === "GET") {
    if (!verifySecret(request, env)) return json({ error: "Invalid secret" }, 403);
    return json({ ok: true, time: Date.now() });
  }
  
  if (path === "/api/jobs" && method === "POST") {
    if (!verifySecret(request, env)) return json({ error: "Invalid secret" }, 403);
    
    const body = await request.json();
    if (!body.chunks?.length) return json({ error: "No chunks provided" }, 400);
    if (!body.keys?.length) return json({ error: "No API keys provided" }, 400);
    
    const jobId = crypto.randomUUID();
    const now = Date.now();
    const liveModelsJson = body.liveModels && body.liveModels.length > 0 ? JSON.stringify(body.liveModels) : null;
    
    if (env.DB) {
      await env.DB.prepare(
        `INSERT INTO jobs (id, file_name, model, keys_json, status, created_at, updated_at, live_models_json, telegram_bot_token, telegram_chat_id, telegram_on_start, telegram_on_progress, telegram_on_error, telegram_on_complete, last_milestone)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
      ).bind(
        jobId,
        body.fileName,
        body.model,
        JSON.stringify(body.keys),
        now,
        now,
        liveModelsJson,
        body.telegramBotToken ?? null,
        body.telegramChatId ?? null,
        body.telegramNotifyOnStart ? 1 : 0,
        body.telegramNotifyOnProgress ? 1 : 0,
        body.telegramNotifyOnError ? 1 : 0,
        body.telegramNotifyOnComplete ? 1 : 0
      ).run();
      
      const BATCH = 25;
      for (let i = 0; i < body.chunks.length; i += BATCH) {
        const batch = body.chunks.slice(i, i + BATCH);
        const stmts = await Promise.all(
          batch.map(async (c, idx) => {
            const text = c.gzip ? await decompressGzip(c.text) : c.text;
            return env.DB.prepare(
              `INSERT INTO chunks (job_id, seq, text, status, attempts, updated_at)
               VALUES (?, ?, ?, 'pending', 0, ?)`
            ).bind(jobId, i + idx, text, now);
          })
        );
        await env.DB.batch(stmts);
      }
    }
    
    if (body.telegramBotToken && body.telegramChatId && body.telegramNotifyOnStart) {
      const sectionCount = body.originalChunkCount ?? body.chunks.length;
      const modelLabel = isGeminiModel(body.model) ? body.model : body.model.split("/").pop()?.replace(/:free$/, "") ?? body.model;
      await sendTelegram(
        body.telegramBotToken,
        body.telegramChatId,
        `🚀 <b>Cloud translation started</b>\n📚 ${body.fileName}\n📦 ${sectionCount} chunks • ⚙️ ${modelLabel}`
      ).catch(() => void 0);
    }
    
    return json({ jobId, totalChunks: body.chunks.length });
  }
  
  const jobMatch = path.match(/^\/api\/jobs\/([a-f0-9-]+)$/);
  if (jobMatch) {
    const jobId = jobMatch[1];
    if (!verifySecret(request, env)) return json({ error: "Invalid secret" }, 403);
    
    if (method === "GET" && env.DB) {
      const job = await env.DB.prepare(`SELECT * FROM jobs WHERE id = ?`).bind(jobId).first();
      if (!job) return json({ error: "Job not found" }, 404);
      
      const counts = await env.DB.prepare(
        `SELECT
           COUNT(*) as total,
           SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
         FROM chunks WHERE job_id = ?`
      ).bind(jobId).first();
      
      const lastChunk = await env.DB.prepare(
        `SELECT MAX(updated_at) as last_at FROM chunks WHERE job_id = ? AND status = 'completed'`
      ).bind(jobId).first();
      
      let pauseReason = null;
      if (job.status === "paused") {
        const failedSample = await env.DB.prepare(
          `SELECT error FROM chunks WHERE job_id = ? AND status = 'failed' AND error LIKE '%quota%' LIMIT 1`
        ).bind(jobId).first();
        if (failedSample) pauseReason = "quota_exhausted";
      }
      
      return json({
        jobId: job.id,
        fileName: job.file_name,
        status: job.status === "active" ? "active" : job.status === "cancelled" ? "cancelled" : job.status === "paused" ? "paused" : "done",
        totalChunks: counts?.total ?? 0,
        completedChunks: counts?.completed ?? 0,
        failedChunks: counts?.failed ?? 0,
        activeModel: job.active_model ?? null,
        createdAt: job.created_at,
        lastHeartbeat: job.last_heartbeat,
        lastChunkAt: lastChunk?.last_at ?? null,
        updatedAt: job.updated_at,
        pauseReason
      });
    }
    
    if (method === "DELETE" && env.DB) {
      await env.DB.prepare(`DELETE FROM chunks WHERE job_id = ?`).bind(jobId).run();
      await env.DB.prepare(`DELETE FROM jobs WHERE id = ?`).bind(jobId).run();
      return json({ ok: true });
    }
  }
  
  const debugMatch = path.match(/^\/api\/jobs\/([a-f0-9-]+)\/debug$/);
  if (debugMatch && method === "GET" && env.DB) {
    const jobId = debugMatch[1];
    if (!verifySecret(request, env)) return json({ error: "Invalid secret" }, 403);
    const rows = await env.DB.prepare(
      `SELECT seq, status, error, model_used, attempts FROM chunks WHERE job_id = ? ORDER BY seq ASC`
    ).bind(jobId).all();
    return json({ chunks: rows.results });
  }
  
  const chunksMatch = path.match(/^\/api\/jobs\/([a-f0-9-]+)\/chunks$/);
  if (chunksMatch && method === "GET" && env.DB) {
    const jobId = chunksMatch[1];
    if (!verifySecret(request, env)) return json({ error: "Invalid secret" }, 403);
    const after = Number(url.searchParams.get("after") ?? "-1");
    const rows = await env.DB.prepare(
      `SELECT seq, translated_text FROM chunks
       WHERE job_id = ? AND seq > ? AND status = 'completed' AND translated_text IS NOT NULL
       ORDER BY seq ASC`
    ).bind(jobId, after).all();
    return json({
      chunks: rows.results.map((r) => ({ id: r.seq, text: r.translated_text }))
    });
  }
  
  if (path === "/api/translate" && method === "POST") {
    if (!verifySecret(request, env)) return json({ error: "Invalid secret" }, 403);
    try {
      const body = await request.json();
      if (!body.text) return json({ error: "Missing text" }, 400);
      if (!body.keys?.length) return json({ error: "No API keys" }, 400);
      
      const { translated, model } = await translateChunk(
        body.text,
        body.keys,
        body.model,
        body.liveModels ?? null
      );
      return json({ translated, model });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return json({ error: msg }, 500);
    }
  }
  
  if (path === "/api/run-cron" && method === "POST") {
    if (!verifySecret(request, env)) return json({ error: "Invalid secret" }, 403);
    try {
      await handleCron(env);
      return json({ ok: true, message: "Cron executed manually" });
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  }
  
  const cancelMatch = path.match(/^\/api\/jobs\/([a-f0-9-]+)\/cancel$/);
  if (cancelMatch && method === "POST" && env.DB) {
    const jobId = cancelMatch[1];
    if (!verifySecret(request, env)) return json({ error: "Invalid secret" }, 403);
    await env.DB.prepare(`UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'active'`).bind(Date.now(), jobId).run();
    await env.DB.prepare(`UPDATE chunks SET status = 'pending' WHERE job_id = ? AND status = 'translating'`).bind(jobId).run();
    return json({ ok: true });
  }
  
  return json({ error: "Not found" }, 404);
}

async function handleCron(env) {
  if (!env.DB) return;
  
  const jobs = await env.DB.prepare(`SELECT * FROM jobs WHERE status = 'active'`).all();
  
  for (const job of jobs.results) {
    const jobId = job.id;
    const keys = JSON.parse(job.keys_json ?? "[]");
    const model = job.model;
    const liveModels = job.live_models_json ? JSON.parse(job.live_models_json) : null;
    const telegramToken = job.telegram_bot_token;
    const telegramChatId = job.telegram_chat_id;
    const notifyOnError = job.telegram_on_error === 1;
    const notifyOnComplete = job.telegram_on_complete === 1;
    const notifyOnProgress = job.telegram_on_progress === 1;
    const lastMilestone = job.last_milestone ?? 0;
    
    if (!keys.length) continue;
    
    await env.DB.prepare(`UPDATE jobs SET last_heartbeat = ?, updated_at = ? WHERE id = ?`).bind(Date.now(), Date.now(), jobId).run();
    
    const pending = await env.DB.prepare(
      `SELECT id, seq, text FROM chunks
       WHERE job_id = ? AND status = 'pending'
       ORDER BY seq ASC
       LIMIT ?`
    ).bind(jobId, BATCH_SIZE).all();
    
    if (pending.results.length === 0) {
      const currentJob = await env.DB.prepare(`SELECT status FROM jobs WHERE id = ?`).bind(jobId).first();
      if (currentJob?.status === "paused") continue;
      
      const counts = await env.DB.prepare(
        `SELECT
           COUNT(*) as total,
           SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
         FROM chunks WHERE job_id = ?`
      ).bind(jobId).first();
      
      const total = counts?.total ?? 0;
      const completed = counts?.completed ?? 0;
      const failed = counts?.failed ?? 0;
      
      if (completed + failed === total && total > 0) {
        const newStatus = failed > 0 ? "done" : "done";
        await env.DB.prepare(`UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?`).bind(newStatus, Date.now(), jobId).run();
        
        if (telegramToken && telegramChatId && notifyOnComplete) {
          await sendTelegram(
            telegramToken,
            telegramChatId,
            `🎉 <b>Cloud translation complete!</b>\n✅ ${completed} chunks translated\n❌ ${failed} failed`
          ).catch(() => void 0);
        }
      }
      continue;
    }
    
    const now = Date.now();
    
    const markStmts = pending.results.map(
      (r) => env.DB.prepare(`UPDATE chunks SET status = 'translating', updated_at = ? WHERE id = ?`).bind(now, r.id)
    );
    await env.DB.batch(markStmts);
    
    let completedDelta = 0;
    let failedDelta = 0;
    
    for (let i = 0; i < pending.results.length; i++) {
      const chunk = pending.results[i];
      const chunkId = chunk.id;
      const seq = chunk.seq;
      const text = chunk.text;
      
      if (i > 0) {
        await new Promise((r) => setTimeout(r, STAGGER_MS));
      }
      
      try {
        const { translated, model: usedModel } = await translateChunk(text, keys, model, liveModels);
        await env.DB.prepare(
          `UPDATE chunks SET status = 'completed', translated_text = ?, model_used = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?`
        ).bind(translated, usedModel, Date.now(), chunkId).run();
        completedDelta++;
        await env.DB.prepare(`UPDATE jobs SET active_model = ?, updated_at = ? WHERE id = ?`).bind(usedModel, Date.now(), jobId).run();
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        
        if (errMsg === "QUOTA_EXHAUSTED") {
          await env.DB.prepare(
            `UPDATE chunks SET status = 'failed', error = 'Daily free-tier quota exhausted', attempts = attempts + 1, updated_at = ? WHERE id = ?`
          ).bind(Date.now(), chunkId).run();
          failedDelta++;
          await env.DB.prepare(`UPDATE jobs SET status = 'paused', updated_at = ? WHERE id = ? AND status = 'active'`).bind(Date.now(), jobId).run();
          
          if (telegramToken && telegramChatId) {
            await sendTelegram(
              telegramToken,
              telegramChatId,
              `⏸️ <b>Translation paused — daily quota exhausted</b>\nAll your OpenRouter keys have hit their daily free limit (50 req/key/day).\n\n⏱️ Resets at midnight UTC.\n💡 Or add $10 credit at openrouter.ai/credits for 1000 req/day.\n\nOpen the app and press Resume when quota is available.`
            ).catch(() => void 0);
          }
          break;
        }
        
        const chunkRow = await env.DB.prepare(`SELECT attempts FROM chunks WHERE id = ?`).bind(chunkId).first();
        const currentAttempts = chunkRow?.attempts ?? 0;
        const newAttempts = currentAttempts + 1;
        
        if (newAttempts >= MAX_RETRIES) {
          await env.DB.prepare(
            `UPDATE chunks SET status = 'failed', error = ?, attempts = ?, updated_at = ? WHERE id = ?`
          ).bind(errMsg.slice(0, 1000), newAttempts, Date.now(), chunkId).run();
          failedDelta++;
          
          if (telegramToken && telegramChatId && notifyOnError) {
            await sendTelegram(
              telegramToken,
              telegramChatId,
              `❌ <b>Chunk ${seq + 1} failed</b>\n<code>${errMsg.slice(0, 150)}</code>`
            ).catch(() => void 0);
          }
        } else {
          await env.DB.prepare(
            `UPDATE chunks SET status = 'pending', attempts = ?, error = ?, updated_at = ? WHERE id = ?`
          ).bind(newAttempts, errMsg.slice(0, 500), Date.now(), chunkId).run();
        }
      }
    }
    
    const counts = await env.DB.prepare(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
       FROM chunks WHERE job_id = ?`
    ).bind(jobId).first();
    
    await env.DB.prepare(
      `UPDATE jobs SET completed_count = ?, failed_count = ?, last_heartbeat = ?, updated_at = ? WHERE id = ?`
    ).bind(
      counts?.completed ?? 0,
      counts?.failed ?? 0,
      Date.now(),
      Date.now(),
      jobId
    ).run();
    
    const postJobStatus = await env.DB.prepare(`SELECT status FROM jobs WHERE id = ?`).bind(jobId).first();
    
    if (failedDelta > 0 && postJobStatus?.status === "active" && telegramToken && telegramChatId) {
      await env.DB.prepare(`UPDATE jobs SET status = 'paused', updated_at = ? WHERE id = ? AND status = 'active'`).bind(Date.now(), jobId).run();
      const failedNow = counts?.failed ?? 0;
      
      await sendTelegram(
        telegramToken,
        telegramChatId,
        `⚠️ <b>Translation paused — chunk failed</b>\n${counts?.completed ?? 0}/${counts?.total ?? 0} done, ${failedNow} failed\nOpen the app and press Resume to retry the failed chunk.`
      ).catch(() => void 0);
    }
    
    if (telegramToken && telegramChatId && notifyOnProgress && counts) {
      const total = counts.total ?? 0;
      const completed = counts.completed ?? 0;
      const pct = total > 0 ? Math.round(completed / total * 100) : 0;
      const milestone = Math.floor(pct / 25) * 25;
      
      if (milestone >= lastMilestone + 25 && milestone < 100 && completed > 0) {
        await env.DB.prepare(`UPDATE jobs SET last_milestone = ? WHERE id = ?`).bind(milestone, jobId).run();
        await sendTelegram(
          telegramToken,
          telegramChatId,
          `📄 <b>Translation ${milestone}%</b>\n${completed}/${total} chunks done`
        ).catch(() => void 0);
      }
    }
  }
}

// Worker entry point - ES Module format
export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (err) {
      console.error("Worker error:", err);
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  },
  async scheduled(_event, env) {
    try {
      await handleCron(env);
    } catch (err) {
      console.error("Cron error:", err);
    }
  }
};
