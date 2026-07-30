import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The eve dev runtime keeps full snapshot copies of the app under
// .eve/dev-runtime/snapshots, so the default include pattern would run every
// suite several times over — once per stale snapshot.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**", "**/.eve/**"],
  },
});
