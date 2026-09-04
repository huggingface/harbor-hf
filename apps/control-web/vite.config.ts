import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: { sourcemap: true },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:7860",
      "/auth": "http://127.0.0.1:7860",
      "/health": "http://127.0.0.1:7860",
    },
  },
});
