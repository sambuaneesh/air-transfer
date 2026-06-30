import react from "@vitejs/plugin-react-swc";
import { defineConfig } from "vite";

export default defineConfig(() => ({
  base: process.env.GITHUB_PAGES === "true" ? "/air-transfer/" : "./",
  plugins: [react()]
}));
