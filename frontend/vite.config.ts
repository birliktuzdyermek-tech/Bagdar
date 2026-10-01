import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const backend = process.env.BAGDAR_BACKEND ?? "http://localhost:8000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      "/api/stream": { target: backend.replace(/^http/, "ws"), ws: true },
      "/api": { target: backend, changeOrigin: true },
    },
  },
});
