import server from "../dist/server/server.js";

export const config = { runtime: "nodejs20.x" };

export default function handler(request) {
  return server.fetch(request, process.env, {});
}
