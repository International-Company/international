import type { NextConfig } from 'next';
import { execSync } from 'node:child_process';

/**
 * What this build calls itself.
 *
 * An installed application can sit open on a phone for days, so it has to be
 * able to notice that a newer one exists — and it can only notice by comparing
 * something. This is that something: baked into the client bundle at build
 * time, and reported live by `/api/version`. When they differ, the copy in the
 * teller's hand is out of date.
 *
 * Derived from the commit where there is one, so two builds of the same source
 * agree and a rebuild does not tell every phone to reload for nothing. Falling
 * back to the build's own timestamp, which is always different and therefore
 * safe in the other direction.
 */
function buildId(): string {
  if (process.env.BUILD_ID) return process.env.BUILD_ID;

  // Railway and most platforms expose the commit; a bare `git` call covers the
  // rest, and a shallow or absent checkout falls through to the clock.
  const fromPlatform =
    process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GIT_SHA;
  if (fromPlatform) return fromPlatform.slice(0, 12);

  try {
    return execSync('git rev-parse --short=12 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return `t${Date.now().toString(36)}`;
  }
}

const BUILD_ID = buildId();

const nextConfig: NextConfig = {
  reactStrictMode: true,
  generateBuildId: () => BUILD_ID,
  // Inlined into both bundles, so the client knows which build it is running
  // and the server knows which build it is serving.
  env: { NEXT_PUBLIC_BUILD_ID: BUILD_ID },
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
        /*
         * Never cached, anywhere. This is the endpoint that says whether the
         * application in someone's hand is current, and a cached answer to that
         * question is the one failure it cannot survive.
         */
        source: '/api/version',
        headers: [{ key: 'Cache-Control', value: 'no-store, must-revalidate' }],
      },
      {
        source: '/manifest.webmanifest',
        headers: [
          { key: 'Content-Type', value: 'application/manifest+json; charset=utf-8' },
          /*
           * Revalidated every time. The installed application's icon and name
           * come from here, and Chrome only notices they changed when it sees a
           * changed manifest — an hour of caching is an hour of the old logo on
           * somebody's home screen.
           */
          { key: 'Cache-Control', value: 'no-cache' },
        ],
      },
    ];
  },
};

export default nextConfig;
