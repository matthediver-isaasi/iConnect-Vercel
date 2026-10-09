import { createServer } from "vite";
import { resolve } from "node:path";

const port = Number(process.argv.find(arg => arg.startsWith("--port="))?.split("=")[1] || 5188);
const server = await createServer({
  configFile: false,
  root: process.cwd(),
  resolve: { alias: { "@": resolve("client/src") } },
  esbuild: { jsx: "automatic" },
  // Do not scan this large application's other entry points for an isolated fixture.
  optimizeDeps: {
    noDiscovery: true,
    include: ["react", "react-dom/client", "lucide-react", "date-fns", "@radix-ui/react-avatar", "clsx", "tailwind-merge"],
  },
  server: { port, strictPort: true, host: "0.0.0.0", watch: null },
});
await server.listen();
console.log(`Tile fixture: http://localhost:${port}/client/src/components/projects/ProjectCardTileSummary.fixture.html`);
