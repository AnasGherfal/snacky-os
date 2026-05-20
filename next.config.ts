import type { NextConfig } from "next";

const forbiddenPublicSecretEnvVars = [
  "NEXT_PUBLIC_SUPABASE_SERVICE_ROLE",
  "NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY",
];

for (const envName of forbiddenPublicSecretEnvVars) {
  if (process.env[envName]) {
    throw new Error(`${envName} must not be set. Service role keys are server-only and must never use NEXT_PUBLIC_.`);
  }
}

const securityHeaders = [
  { key: "X-DNS-Prefetch-Control", value: "off" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "microphone=(), payment=(), usb=(), serial=(), bluetooth=(), accelerometer=(), gyroscope=(), magnetometer=()",
  },
];

if (process.env.NODE_ENV === "production") {
  securityHeaders.push({ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" });
}

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
