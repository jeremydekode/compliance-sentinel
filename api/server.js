import server from "../dist/server/server.js";

export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  try {
    // 1. Build absolute URL from Node request
    const proto = req.headers["x-forwarded-proto"] ?? "https";
    const host  = req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost";
    const url   = `${proto}://${host}${req.url}`;

    // 2. Convert Node headers (plain object) to Web Headers
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) value.forEach(v => headers.append(key, v));
      else if (value !== undefined) headers.set(key, String(value));
    }

    // 3. Buffer body for non-GET/HEAD methods
    let body;
    if (req.method && req.method !== "GET" && req.method !== "HEAD") {
      body = await new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
      });
    }

    // 4. Construct Web Request and invoke SSR handler
    const request = new Request(url, {
      method: req.method,
      headers,
      body,
      duplex: "half",
    });
    const response = await server.fetch(request, process.env, {});

    // 5. Pipe Web Response back to Node res
    res.statusCode = response.status;
    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });
    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
    }
    res.end();
  } catch (err) {
    console.error("[api/server] handler crashed:", err);
    res.statusCode = 500;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end(`Internal Server Error: ${err?.message ?? String(err)}`);
  }
}
