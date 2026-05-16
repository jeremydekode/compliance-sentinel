import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";
dotenv.config();

async function test() {
  const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GENERATIVE_AI_API_KEY || "");
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const result = await model.generateContent("Hi");
    console.log("Success:", result.response.text());
  } catch (err: any) {
    console.error("Error:", err.message);
    if (err.message.includes("suspended")) {
      console.log("CRITICAL: The API Key is officially suspended by Google.");
    }
  }
}
test();
