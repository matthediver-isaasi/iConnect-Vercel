import { createServer } from "vite";
import { resolve } from "node:path";

if (!process.argv.includes("--serve")) {
  console.log("Run: node client/src/components/projects/boardMentions.fixture.mjs --serve [--port=5188]");
} else {
  const port = Number(process.argv.find((arg) => arg.startsWith("--port="))?.split("=")[1] || 5188);
  const server = await createServer({
    configFile: false,
    root: process.cwd(),
    resolve: { alias: { "@": resolve("client/src") } },
    esbuild: { jsx: "automatic" },
    server: { port, strictPort: true, host: "0.0.0.0", watch: null },
  });
  await server.listen();
  console.log(`Isolated fixture: http://localhost:${port}/client/src/components/projects/boardMentions.fixture.html`);
}
