import { GoogleGenerativeAI } from "@google/generative-ai";

async function test() {
  const genAI = new GoogleGenerativeAI("AIzaSyC8VI-IdJGfOtYLh_TJsJ_-MYcbN2ncEmo");
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const result = await model.generateContent("Hi");
    console.log("Success:", result.response.text());
  } catch (err: any) {
    console.error("Error:", err.message);
  }
}
test();
