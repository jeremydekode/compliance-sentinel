import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tsconfigPaths from "vite-tsconfig-paths";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [
    tanstackStart(),
    react(),
    tsconfigPaths(),
    tailwindcss(),
  ],
  // Pre-bundle heavy deps that are only imported inside lazily-loaded routes
  // (the credit report). Without this, Vite discovers them on first navigation,
  // re-optimizes, and the in-flight chunk 504s ("Outdated Optimize Dep").
  optimizeDeps: {
    include: ["pdfjs-dist", "react-markdown"],
  },
});
