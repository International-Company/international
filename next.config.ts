import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  serverExternalPackages: ['@prisma/client', 'exceljs'],

  // `experimental.optimizePackageImports` was removed deliberately.
  //
  // It rewrites barrel imports and reshapes the shared chunk graph, and it
  // produced a build that succeeded on one platform and failed on another
  // while prerendering the 404 shell. Next.js already applies this optimisation
  // to common packages by default, so the flag bought little and cost
  // reproducibility — which matters far more in a deployment pipeline than a
  // few kilobytes.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-DNS-Prefetch-Control', value: 'off' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=()',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
