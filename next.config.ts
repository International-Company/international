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
            // `publickey-credentials-get` is left out of the deny list on
            // purpose: it is what a passkey sign-in needs, and naming it here
            // with an empty allowlist would switch fingerprint login off.
            value: 'camera=(), microphone=(), geolocation=(), payment=()',
          },
        ],
      },
      {
        /*
         * The worker file must be revalidated on every load.
         *
         * Served with the default static caching it can sit in the browser for
         * a day, so a correction to what the worker is allowed to cache would
         * not reach the phones it was written for until the day after.
         */
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
      {
        source: '/manifest.webmanifest',
        headers: [
          { key: 'Content-Type', value: 'application/manifest+json; charset=utf-8' },
          { key: 'Cache-Control', value: 'public, max-age=3600' },
        ],
      },
    ];
  },
};

export default nextConfig;
