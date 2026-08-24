import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  transpilePackages: [
    "@seo-autopilot/api",
    "@seo-autopilot/connectors",
    "@seo-autopilot/core",
    "@seo-autopilot/database",
  ],
};

export default config;
