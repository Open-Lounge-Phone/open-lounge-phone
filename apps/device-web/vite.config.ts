import { defineConfig } from "vite";

// Served by the self-host server at /device/. In dev, API and sockets proxy to it on :8787.
export default defineConfig({
  base: "/device/",
  server: {
    port: 5174,
    proxy: {
      "/api": "http://localhost:8787",
      "/ws": { target: "ws://localhost:8787", ws: true },
    },
  },
});
