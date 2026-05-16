import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY || "" });

export async function generateEmbedding(text: string): Promise<number[]> {
  const result = await ai.models.embedContent({
    model: "gemini-embedding-2",
    contents: text.slice(0, 30000),
    config: { taskType: "RETRIEVAL_DOCUMENT", outputDimensionality: 1536 },
  });
  return result.embeddings?.[0]?.values ?? [];
}

export async function generateQueryEmbedding(text: string): Promise<number[]> {
  const result = await ai.models.embedContent({
    model: "gemini-embedding-2",
    contents: text,
    config: { taskType: "RETRIEVAL_QUERY", outputDimensionality: 1536 },
  });
  return result.embeddings?.[0]?.values ?? [];
}
