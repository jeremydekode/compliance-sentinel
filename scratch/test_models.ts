import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";
dotenv.config();

async function test() {
  const key = process.env.GOOGLE_GENERATIVE_AI_API_KEY || "";
  const genAI = new GoogleGenerativeAI(key);
  
  const models = [
    "gemini-flash-latest",
    "gemini-2.0-flash-lite",
    "gemini-2.5-flash"
  ];

  for (const modelName of models) {
    try {
      console.log(`Testing Chat (${modelName})...`);
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent("Hello");
      console.log(`Chat Success (${modelName}):`, result.response.text());
      return; // Stop on first success
    } catch (err: any) {
      console.error(`Chat Error (${modelName}):`, err.message);
    }
  }
}
test();
