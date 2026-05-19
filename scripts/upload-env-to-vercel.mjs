// Uploads .env values to a Vercel project via REST API.
// Skips printing secret values to stdout.
import fs from "node:fs";
import path from "node:path";

const TOKEN = JSON.parse(
  fs.readFileSync(path.join(process.env.HOME, "Library/Application Support/com.vercel.cli/auth.json"), "utf8")
).token;
const PROJ_ID = "prj_d3CISEoJCsETUPYQLEFxCTHJlAi0";
const ORG_ID  = "team_JWdlOEJk7W0M52IGiJRJ0Mjr";

const envFile = fs.readFileSync(".env", "utf8");
const pairs = envFile.split("\n")
  .filter((l) => /^[A-Z]/.test(l))
  .map((l) => {
    const i = l.indexOf("=");
    return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
  });

for (const [key, value] of pairs) {
  const r = await fetch(`https://api.vercel.com/v10/projects/${PROJ_ID}/env?teamId=${ORG_ID}&upsert=true`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ key, value, type: "encrypted", target: ["production", "preview", "development"] }),
  });
  const status = r.ok ? "✓" : `✗ (${r.status})`;
  console.log(`  ${status}  ${key}`);
  if (!r.ok) console.log(`        ${await r.text()}`);
}
console.log(`Done — ${pairs.length} env vars`);
