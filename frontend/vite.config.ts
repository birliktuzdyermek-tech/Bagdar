import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const backend = process.env.BAGDAR_BACKEND ?? "http://localhost:8000";

export default defineConfig({
  plugins: [react()],
  build: {
    // графики (ECharts + zrender) — отдельный чанк: кэшируется независимо от кода приложения
    chunkSizeWarningLimit: 700,
    rolldownOptions: {
      output: {
        advancedChunks: { groups: [{ name: "charts-vendor", test: /node_modules[\\/](echarts|zrender)/ }] },
      },
    },
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      "/api/stream": { target: backend.replace(/^http/, "ws"), ws: true },
      "/api": { target: backend, changeOrigin: true },
    },
  },
});
