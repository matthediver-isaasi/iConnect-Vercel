import { defineConfig, mergeConfig } from "vite";
import base from "../vite.config.ts";

// Frontend only: the browser fixture intercepts all API/provider requests.
export default mergeConfig(base, defineConfig({
  server: { host: "0.0.0.0", port: 5189, strictPort: true, allowedHosts: true, watch: null },
}));
