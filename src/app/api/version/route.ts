import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Which build is being served right now.
 *
 * Read from `.next/BUILD_ID` — the file `next build` writes — and not from the
 * environment, which is what the first version did and what made the
 * application reload itself in a loop.
 *
 * The environment is the wrong source in two ways at once. `next.config` is
 * evaluated again when the server starts, so anything derived there at runtime
 * (a timestamp, a git call in a container with no `.git`) produces a different
 * answer from the one compiled into the browser's copy — and the two never
 * agree, so every check reports an update that reloading cannot resolve. And
 * where a platform runs more than one instance, two of them can disagree with
 * each other, so the answer flips with whichever replica happens to reply.
 *
 * The build file has neither problem: it is written once by the build, shipped
 * with it, and identical on every instance of the same deployment.
 *
 * Public, because the sign-in screen updates too, and deliberately says nothing
 * else: an opaque build id, not a version tied to a changelog.
 */
export const dynamic = 'force-dynamic';

/** Read once — it cannot change while this process is alive. */
let cached: string | null | undefined;

function buildId(): string | null {
  if (cached !== undefined) return cached;

  try {
    cached = readFileSync(path.join(process.cwd(), '.next', 'BUILD_ID'), 'utf8').trim() || null;
  } catch {
    // Development, or a layout this does not know. Reporting nothing is the
    // safe answer: the client treats it as "no information" and leaves the
    // person alone rather than reloading on a guess.
    cached = null;
  }

  return cached;
}

export async function GET(): Promise<Response> {
  return Response.json(
    { build: buildId() },
    { status: 200, headers: { 'cache-control': 'no-store' } },
  );
}
