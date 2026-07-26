import { withEve } from "eve/next";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Remotion's renderer/bundler ship platform binaries (headless shell,
  // compositor) that must not be bundled; load them from node_modules at
  // runtime instead.
  serverExternalPackages: ["remotion", "@remotion/bundler", "@remotion/renderer"],
};

// Mounts the eve agent (./agent) on this app's origin: one dev server, one
// Vercel deployment. /eve/v1/** routes to the agent service.
export default withEve(nextConfig);
