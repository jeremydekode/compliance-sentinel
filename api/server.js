import server from "../dist/server/server.js";

export const config = { runtime: "nodejs" };

export default function handler(request) {
  // Vercel's Node runtime sometimes passes a relative URL — reconstruct it as absolute.
  let url;
  try {
    url = new URL(request.url);
  } catch {
    const proto = request.headers.get("x-forwarded-proto") ?? "https";
    const host  = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "localhost";
    const path  = request.url?.startsWith("/") ? request.url : `/${request.url ?? ""}`;
    url = new URL(`${proto}://${host}${path}`);
  }

  const normalized = new Request(url, request);
  return server.fetch(normalized, process.env, {});
}
