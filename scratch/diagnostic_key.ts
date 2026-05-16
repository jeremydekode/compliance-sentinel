import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";
dotenv.config();

async function test() {
  const key = process.env.GOOGLE_GENERATIVE_AI_API_KEY || "";
  console.log("Testing Key:", key.substring(0, 10) + "...");
  const genAI = new GoogleGenerativeAI(key);
  
  try {
    console.log("Testing Chat (gemini-1.5-flash)...");
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const result = await model.generateContent("Hello");
    console.log("Chat Success:", result.response.text());
  } catch (err: any) {
    console.error("Chat Error:", err.message);
  }

  try {
    console.log("Testing Embedding (gemini-embedding-2)...");
    const model = genAI.getGenerativeModel({ model: "gemini-embedding-2" });
    const result = await model.embedContent("Hello world");
    console.log("Embedding Success: Vector length", result.embedding.values.length);
  } catch (err: any) {
    console.error("Embedding Error:", err.message);
  }
}
test();
