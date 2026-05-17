// Generic one-shot DOCX indexer.
// Usage: node scripts/index-docx.mjs <file-path> <workspace> <title-hint>
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
import mammoth from "mammoth";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

dotenv.config({ path: "/Users/jeremyteh/Downloads/Compliance Sentinel/.env" });

const [, , FILE_PATH, WORKSPACE = "fatf", TITLE_HINT] = process.argv;
if (!FILE_PATH || !TITLE_HINT) {
  console.error("Usage: node scripts/index-docx.mjs <file-path> <workspace> <title-hint>");
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY
);
const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY });
const BATCH_SIZE = 50;

async function embedBatch(texts, attempt = 0) {
  try {
    const resp = await ai.models.embedContent({
      model: "gemini-embedding-2",
      contents: texts.map((t) => ({ role: "user", parts: [{ text: t.slice(0, 30000) }] })),
      config: { outputDimensionality: 1536 },
    });
    return resp.embeddings.map((e) => e.values);
  } catch (e) {
    const msg = String(e?.message || "");
    if ((msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED")) && attempt < 6) {
      const backoff = Math.min(60, 10 * Math.pow(2, attempt));
      console.log(`\n  rate-limited, waiting ${backoff}s…`);
      await new Promise((r) => setTimeout(r, backoff * 1000));
      return embedBatch(texts, attempt + 1);
    }
    throw e;
  }
}

// 1. Find SOP
const { data: sops } = await supabase
  .from("sop_documents")
  .select("id,title,workspace_id")
  .eq("workspace_id", WORKSPACE)
  .ilike("title", `%${TITLE_HINT}%`);
if (!sops?.length) {
  console.error(`No SOP matching "${TITLE_HINT}" in workspace "${WORKSPACE}"`);
  process.exit(1);
}
const sop = sops[0];
console.log(`Target: ${sop.title} (${sop.id})`);

// 2. Wipe old chunks
await supabase.from("sop_chunks").delete().eq("sop_id", sop.id);

// 3. Extract + chunk
console.log("Extracting…");
const buffer = fs.readFileSync(FILE_PATH);
const { value: fullText } = await mammoth.extractRawText({ buffer });
const paragraphs = fullText.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
const chunks = [];
let buf = [], bufLen = 0, currentSection;
const headingRegex = /^(?:(?:[A-Z]\.\s*)?\d+(?:\.\d+)*\.?\s+[A-Z]|Section\s+\d|Chapter\s+\d|Appendix\s+[IVX0-9])/i;
for (const p of paragraphs) {
  if (p.length < 120 && headingRegex.test(p)) currentSection = p.slice(0, 80);
  if (bufLen + p.length > 600 && buf.length > 0) {
    chunks.push({ content: buf.join("\n\n"), chapter_ref: currentSection });
    buf = []; bufLen = 0;
  }
  buf.push(p); bufLen += p.length;
}
if (buf.length > 0) chunks.push({ content: buf.join("\n\n"), chapter_ref: currentSection });
console.log(`${chunks.length} chunks · ${Math.ceil(chunks.length / BATCH_SIZE)} API calls`);

// 4. Batch-embed
const rows = [];
const t0 = Date.now();
for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
  const batch = chunks.slice(i, i + BATCH_SIZE);
  const vectors = await embedBatch(batch.map((c) => c.content));
  for (let j = 0; j < batch.length; j++) {
    rows.push({
      sop_id: sop.id,
      content: batch[j].content,
      chapter_ref: batch[j].chapter_ref ?? null,
      page_number: null,
      embedding: vectors[j],
    });
  }
  process.stdout.write(`  ${rows.length}/${chunks.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)\r`);
}
console.log(`\nEmbedded in ${((Date.now() - t0) / 1000).toFixed(0)}s. Inserting…`);

// 5. Insert in batches of 100
for (let i = 0; i < rows.length; i += 100) {
  const { error } = await supabase.from("sop_chunks").insert(rows.slice(i, i + 100));
  if (error) { console.error(`Insert failed at ${i}:`, error.message); process.exit(1); }
}
console.log(`✓ Done. ${rows.length} chunks inserted for "${sop.title}"`);
