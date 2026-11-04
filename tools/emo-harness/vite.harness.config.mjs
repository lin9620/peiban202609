import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import path from "node:path";
const R = "D:\\05ruanjian\\peiban";
export default defineConfig({
  root: path.join(R, "tools", "emo-harness"),
  base: "./",
  plugins: [vue()],
  resolve: { alias: { "@": path.join(R, "src") } },
  define: { "process.env.NODE_ENV": '"production"' },
  build: { outDir: "D:\\05ruanjian\\peiban\\tools\\_emo-harness-dist", emptyOutDir: true, target: "es2019" },
});
