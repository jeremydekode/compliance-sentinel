# Exact in-app docx editor — OnlyOffice deploy runbook

The "Edit (exact)" button embeds an **OnlyOffice Document Server** so a `.docx`
can be edited inside the app with Word-grade fidelity (real logo, tables, fonts),
then saved straight back to Supabase storage.

OnlyOffice is a stateful, always-on server — it **cannot** run on Vercel. Host it
once on any container platform. It's cheap (~$5/mo) and the app just points at it.

---

## 1. Deploy the container (pick one host)

You need the shared JWT secret first. It's already in the app's `.env` as
`ONLYOFFICE_JWT_SECRET` — copy that value; the server must use the SAME one.

### Option A — Railway (easiest, HTTPS + domain automatic)
1. New Project → **Deploy a Docker Image** → image `onlyoffice/documentserver:latest`.
2. Variables:
   - `JWT_ENABLED` = `true`
   - `JWT_SECRET` = *(paste ONLYOFFICE_JWT_SECRET from the app's .env)*
   - `JWT_HEADER` = `Authorization`
3. Settings → Networking → **Generate Domain** (gives you an `https://…up.railway.app` URL).
4. Give it ~2 GB RAM (Settings → Resources).

### Option B — Fly.io
```
fly launch --image onlyoffice/documentserver:latest --no-deploy
fly secrets set JWT_ENABLED=true JWT_HEADER=Authorization JWT_SECRET=<paste secret>
fly scale memory 2048
fly deploy
```
Fly gives you `https://<app>.fly.dev`.

### Option C — Any VPS with Docker (Hetzner ~€4/mo, DigitalOcean, etc.)
```
# on the server, in this folder, with ONLYOFFICE_JWT_SECRET exported:
docker compose up -d
```
Then put a TLS proxy in front (Caddy auto-provisions HTTPS):
```
# /etc/caddy/Caddyfile
docs.yourdomain.com {
    reverse_proxy localhost:80
}
```

**HTTPS is required** — browsers refuse to embed a mixed-content (http) editor into
your https app.

---

## 2. Point the app at it

Set the server's public HTTPS URL as `ONLYOFFICE_URL` in **both** places:

- Local: edit `.env` → `ONLYOFFICE_URL=https://<your-onlyoffice-host>`
- Vercel (production):
  ```
  npx vercel env add ONLYOFFICE_URL production      # paste the https URL
  npx vercel env add ONLYOFFICE_JWT_SECRET production   # paste the same secret from .env
  npx vercel --prod                                 # redeploy so functions pick them up
  ```

That's it. The "Edit (exact)" button then opens the document in OnlyOffice, and
edits save back to Supabase automatically.

---

## Verify the server is up
Visit `https://<your-onlyoffice-host>/healthcheck` → should return `true`.
The editor's API script lives at `https://<your-onlyoffice-host>/web-apps/apps/api/documents/api.js`.

## Notes
- The **save-back callback** (`/api/onlyoffice-callback`) runs on Vercel and must be
  reachable from the OnlyOffice server (it is — it's a public https URL). This means
  editing only saves when using the **deployed** app, not `localhost` (the remote
  OnlyOffice server can't reach your laptop).
- Community edition is free and has no watermark. Concurrent-editing limits are far
  beyond a review workflow's needs.
