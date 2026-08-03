# Cloud Run image. Multi-stage: build with full (dev) deps, run with
# production deps only — heavy packages like pizzip/mammoth/pdfjs-dist stay
# as real node_modules imports in the built server chunks, so the runtime
# stage needs node_modules, not just dist/.

FROM node:22-slim AS builder
WORKDIR /app

# These two are baked into the client bundle at BUILD time by Vite
# (import.meta.env.VITE_*) — unlike every other secret in this app, they
# can't be supplied as a runtime env var on the container, so they have to
# arrive as build args instead. Both are public/publishable values already
# meant to ship in client-side JS, not privileged secrets.
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_PUBLISHABLE_KEY=$VITE_SUPABASE_PUBLISHABLE_KEY

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY server.cloud-run.mjs ./

# Cloud Run injects PORT at runtime; 8080 is just the documented default.
EXPOSE 8080
CMD ["node", "server.cloud-run.mjs"]
