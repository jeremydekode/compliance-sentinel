// OnlyOffice save-back webhook (Vercel function, runs outside the SSR handler).
// The Document Server POSTs here when an edited doc is ready; we download it and
// write it back to Supabase storage at the path pinned in our signed `t` token.
// Security: both OnlyOffice's own JWT (body.token) AND our path token must verify.
import { createHmac, timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

export const config = { runtime: "nodejs" };

function verifyJwt(token, secret) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts;
  const expected = Buffer.from(
    createHmac("sha256", secret).update(`${head}.${body}`).digest(),
  ).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
    if (typeof payload.exp === "number" && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: 1 });
    return;
  }
  const secret = process.env.ONLYOFFICE_JWT_SECRET;
  if (!secret) {
    res.status(200).json({ error: 1 });
    return;
  }

  // Our path-pinned token (query ?t=…) — restricts which object may be written.
  const url = new URL(req.url, "https://placeholder");
  const pinned = verifyJwt(url.searchParams.get("t"), secret);
  if (!pinned || !pinned.path) {
    res.status(200).json({ error: 1 });
    return;
  }

  // Read the callback body (Vercel may pre-parse JSON into req.body).
  let body = req.body;
  if (!body || typeof body !== "object") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    try { body = JSON.parse(raw || "{}"); } catch { body = {}; }
  }

  // OnlyOffice signs the payload; trust the token's fields, not the plaintext.
  const ooToken = body.token || (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const signed = verifyJwt(ooToken, secret);
  if (!signed) {
    res.status(200).json({ error: 1 }); // unsigned / forged — reject
    return;
  }

  const status = signed.status ?? body.status;
  const downloadUrl = signed.url ?? body.url;

  // 2 = ready to save (all editors closed); 6 = force-save (save, keep editing).
  if ((status === 2 || status === 6) && downloadUrl) {
    try {
      const r = await fetch(downloadUrl);
      if (!r.ok) throw new Error(`fetch edited doc ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const up = await supabase.storage.from("policies").upload(pinned.path, buf, {
        upsert: true,
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      });
      if (up.error) throw up.error;
      // Stamp a marker so the app can detect the save actually landed (used by
      // finalizeEdit to wait before letting the reviewer reopen the doc).
      if (pinned.reportId) {
        const { data: rep } = await supabase
          .from("analysis_reports").select("summary_json").eq("id", pinned.reportId).single();
        const sj = rep?.summary_json ?? {};
        await supabase.from("analysis_reports")
          .update({ summary_json: { ...sj, editSavedAt: Date.now() } })
          .eq("id", pinned.reportId);
      }
    } catch (e) {
      console.error("[onlyoffice-callback] save failed:", e?.message);
      res.status(200).json({ error: 1 }); // signal OnlyOffice to retry
      return;
    }
  }

  res.status(200).json({ error: 0 });
}
