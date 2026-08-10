import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `base: "./"` keeps the built asset URLs relative so the bundle works no
// matter which loopback port the server happened to bind.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // `npm run dev` serves the SPA; the API still comes from `agent-manager ui`.
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4317",
        changeOrigin: false,
      },
    },
  },
});
