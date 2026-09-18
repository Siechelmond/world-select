import type { NextConfig } from "next";

const isGitHubActions = process.env.GITHUB_ACTIONS === "true";
const repositoryName = "world-select";
const basePath = isGitHubActions ? `/${repositoryName}` : "";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: "export",
  trailingSlash: true,
  basePath,
  assetPrefix: basePath,
  images: {
    unoptimized: true,
  },
  env: {
    NEXT_PUBLIC_BUILD_BRANCH: process.env.CF_PAGES_BRANCH ?? process.env.GITHUB_REF_NAME ?? 'local',
    NEXT_PUBLIC_BUILD_COMMIT: (process.env.CF_PAGES_COMMIT_SHA ?? process.env.GITHUB_SHA ?? 'unknown').slice(0, 8),
    NEXT_PUBLIC_BUILD_AT: new Date().toISOString(),
  },
};

export default nextConfig;
