import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// The app resolves "@/" to ./src (see tsconfig paths); vitest does not
// read tsconfig paths, so the alias is repeated here for the tests —
// the route tests import handlers that import "@/lib/jobs".
// jobs.ts also imports contracts/deployments/celo.json, which lives
// outside the app root, so the repo root is allowed for file serving.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    fs: {
      allow: [fileURLToPath(new URL("../..", import.meta.url))],
    },
  },
});
