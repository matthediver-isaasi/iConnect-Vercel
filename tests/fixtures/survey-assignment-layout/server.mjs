import { build } from "esbuild";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import path from "node:path";

// No tenant client is bundled. All data and lifecycle previews stay in this fixture.
const bundle = await build({
  entryPoints: ["tests/fixtures/survey-assignment-layout/main.jsx"],
  bundle: true, write: false, format: "esm", platform: "browser", jsx: "automatic",
  alias: { "@": path.resolve("client/src") },
  plugins: [{
    name: "isolated-entities",
    setup(builder) {
      builder.onResolve({ filter: /base44Client$/ }, () => ({ path: "entities", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
        contents: `export const base44 = { entities: new Proxy({}, { get: (_, name) => ({
          filter: async () => window.fixtureRead(name), list: async () => []
        }) }) };`,
      }));
    },
  }],
});
const css = execFileSync("node_modules/.bin/tailwindcss", [
  "-i", "client/src/index.css", "--content",
  "client/src/components/surveys/*.jsx,client/src/components/ui/*.{jsx,tsx},tests/fixtures/survey-assignment-layout/main.jsx",
], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
createServer((req, res) => {
  if (req.url === "/bundle.js") {
    res.setHeader("Content-Type", "text/javascript");
    return res.end(bundle.outputFiles[0].text);
  }
  if (req.url === "/style.css") {
    res.setHeader("Content-Type", "text/css");
    return res.end(css);
  }
  if (req.url.startsWith("/api/")) {
    res.writeHead(500);
    return res.end("Unexpected fixture API request");
  }
  res.setHeader("Content-Type", "text/html");
  res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>');
}).listen(5188, "0.0.0.0");
