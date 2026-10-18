import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: "0.0.0.0" },
  build: { target: ["safari15", "chrome80"] },
});
