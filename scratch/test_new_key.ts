import { GoogleGenerativeAI } from "@google/generative-ai";

async function test() {
  const genAI = new GoogleGenerativeAI("AIzaSyCBGKtP6rnYYmAAfPqZzbdPztWxcst1NwY");
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const result = await model.generateContent("Hi");
    console.log("Success:", result.response.text());
  } catch (err: any) {
    console.error("Error:", err.message);
  }
}
test();
