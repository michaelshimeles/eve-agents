import path from "node:path";

import type { NextConfig } from "next";

// The deploy API assembles the agent deployment from apps/eve source at
// runtime, so those files must ship inside the serverless function bundle.
// The excludes matter: without them tracing would drag apps/eve's
// node_modules, build output, and — critically — .env.local (real secrets)
// into the builder's deployment.
const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  outputFileTracingIncludes: {
    "/api/deploy": ["../eve/**"],
  },
  outputFileTracingExcludes: {
    "/api/deploy": [
      "../eve/node_modules/**",
      "../eve/.next/**",
      "../eve/.env*",
      "../eve/.eve/**",
      "../eve/.turbo/**",
      "../eve/.output/**",
      "../eve/.vercel/**",
      "../eve/*.tsbuildinfo",
    ],
  },
};

export default nextConfig;
