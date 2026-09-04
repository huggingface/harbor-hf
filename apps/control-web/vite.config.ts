import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiOrigin = `http://127.0.0.1:${process.env.HARBOR_HF_DEV_API_PORT ?? "7861"}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom", "react-router-dom"],
          state: ["@tanstack/react-query", "@tanstack/react-table"],
        },
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": apiOrigin,
      "/auth": apiOrigin,
      "/health": apiOrigin,
    },
  },
});
