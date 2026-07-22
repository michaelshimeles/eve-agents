import { withEve } from "eve/next";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {};

// Mounts the eve agent (./agent) on this app's origin: one dev server, one
// Vercel deployment. /eve/v1/** routes to the agent service.
export default withEve(nextConfig);
