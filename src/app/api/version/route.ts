/**
 * Which build is being served right now.
 *
 * The installed application polls this and compares it with the build it was
 * itself loaded from. When they differ, a newer version is live and the copy on
 * the phone is stale.
 *
 * Public, because the sign-in screen has to update too, and deliberately says
 * nothing else: a build identifier tells an attacker which commit is deployed,
 * which is why it is a short opaque id and not a version number tied to a
 * changelog. Everything else about this process stays behind the session.
 */
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return Response.json(
    { build: process.env.NEXT_PUBLIC_BUILD_ID ?? 'development' },
    { status: 200, headers: { 'cache-control': 'no-store' } },
  );
}
