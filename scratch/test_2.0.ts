import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";
dotenv.config();

async function test() {
  const key = process.env.GOOGLE_GENERATIVE_AI_API_KEY || "";
  const genAI = new GoogleGenerativeAI(key);
  
  try {
    console.log("Testing Chat (gemini-2.0-flash)...");
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const result = await model.generateContent("Hello");
    console.log("Chat Success:", result.response.text());
  } catch (err: any) {
    console.error("Chat Error:", err.message);
  }
}
test();
