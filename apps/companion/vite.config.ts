import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Served by the self-host server at /. In dev, API and sockets proxy to it on :8787.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8787",
      "/ws": { target: "ws://localhost:8787", ws: true },
    },
  },
});
