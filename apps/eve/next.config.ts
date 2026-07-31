import { withEve } from "eve/next";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  // Keep Turbopack inside this worktree. Without an explicit root, a nested
  // git worktree can be mistaken for the original checkout when both contain
  // package-lock.json files.
  turbopack: {
    root: fileURLToPath(new URL("../..", import.meta.url)),
  },
  // T3's collaborative preview reaches local dev through 127.0.0.1.
  // Allow that development origin so HMR and local fonts render there.
  allowedDevOrigins: ["127.0.0.1"],
  // Remotion's renderer/bundler ship platform binaries (headless shell,
  // compositor) that must not be bundled; load them from node_modules at
  // runtime instead. Spectrum's SDK rides on gRPC with the same constraint.
  serverExternalPackages: [
    "remotion",
    "@remotion/bundler",
    "@remotion/renderer",
    "@spectrum-ts/imessage",
    "@photon-ai/advanced-imessage",
    "heif2jpeg",
    "raindrop-ai",
  ],
  async headers() {
    return [
      {
        source: "/imessage/apps/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
        ],
      },
    ];
  },
  async rewrites() {
    if (process.env.NODE_ENV !== "development") return [];
    return [
      {
        source: "/__eve-workspace-relay/:path*",
        destination: "http://127.0.0.1:4549/:path*",
      },
    ];
  },
};

// Mounts the eve agent (./agent) on this app's origin: one dev server, one
// Vercel deployment. /eve/v1/** routes to the agent service.
export default withWorkflow(withEve(nextConfig));
