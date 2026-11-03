/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  outputFileTracingIncludes: {
    "/api/**/*": ["./prompts/**/*"],
  },
  experimental: {
    agentUpgrade: "security",
  },
};

export default nextConfig;
