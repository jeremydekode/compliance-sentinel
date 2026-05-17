import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY || "" });

async function embedWithRetry(
  texts: string[],
  taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY",
  attempt = 0
): Promise<number[][]> {
  try {
    const result = await ai.models.embedContent({
      model: "gemini-embedding-2",
      contents: texts.map((t) => ({ role: "user", parts: [{ text: t.slice(0, 30000) }] })),
      config: { taskType, outputDimensionality: 1536 },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (result.embeddings ?? []).map((e: any) => e.values);
  } catch (e: any) {
    const msg = String(e?.message || "");
    const isRateLimit = msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED") || msg.includes("quota");
    if (isRateLimit && attempt < 6) {
      const backoffSec = Math.min(60, 5 * Math.pow(2, attempt));
      console.warn(`Embedding rate-limited, retrying in ${backoffSec}s (attempt ${attempt + 1})`);
      await new Promise((r) => setTimeout(r, backoffSec * 1000));
      return embedWithRetry(texts, taskType, attempt + 1);
    }
    throw e;
  }
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const [vec] = await embedWithRetry([text], "RETRIEVAL_DOCUMENT");
  return vec ?? [];
}

export async function generateQueryEmbedding(text: string): Promise<number[]> {
  const [vec] = await embedWithRetry([text], "RETRIEVAL_QUERY");
  return vec ?? [];
}

/**
 * Batch-embed many documents in a single Gemini call (up to 50 per request).
 * Use this for bulk indexing — it's ~50x fewer API calls than calling
 * generateEmbedding() in a loop and dodges per-request rate limits cleanly.
 */
export async function generateEmbeddingsBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const out: number[][] = [];
  const BATCH = 50;
  for (let i = 0; i < texts.length; i += BATCH) {
    const slice = texts.slice(i, i + BATCH);
    const vecs = await embedWithRetry(slice, "RETRIEVAL_DOCUMENT");
    out.push(...vecs);
  }
  return out;
}
