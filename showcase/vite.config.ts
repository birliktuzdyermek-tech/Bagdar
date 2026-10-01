import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Статический сайт без сервера: base "./" — сборку можно открыть с любого адреса
// и с флешки. Токены стиля берутся из общего пакета contracts/ в корне репозитория.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  base: "./",
  plugins: [react()],
  server: { port: 5180, fs: { allow: [repoRoot] } },
  preview: { port: 5180 },
  build: { target: "es2022", assetsInlineLimit: 0, chunkSizeWarningLimit: 800 },
});
