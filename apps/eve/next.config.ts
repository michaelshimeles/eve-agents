import { withEve } from "eve/next";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Remotion's renderer/bundler ship platform binaries (headless shell,
  // compositor) that must not be bundled; load them from node_modules at
  // runtime instead. Spectrum's SDK rides on gRPC with the same constraint.
  serverExternalPackages: [
    "remotion",
    "@remotion/bundler",
    "@remotion/renderer",
    "@spectrum-ts/core",
    "@spectrum-ts/imessage",
    "heif2jpeg",
  ],
};

// Mounts the eve agent (./agent) on this app's origin: one dev server, one
// Vercel deployment. /eve/v1/** routes to the agent service.
export default withEve(nextConfig);
