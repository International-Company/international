import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NAVIGATION } from '../src/app/_shell/navigation.ts';

/**
 * The keyboard sequences are read from the sidebar, so the sidebar is what has
 * to be right: every shortcut it shows must be one the keyboard can type, and no
 * two items may claim the same one — the second would simply never be reached.
 */
describe('sidebar shortcuts', () => {
  const shown = NAVIGATION.flatMap((section) => section.items).filter((item) => item.shortcut);

  it('are all of the form "g" and one letter', () => {
    for (const item of shown) {
      assert.match(item.shortcut!, /^g [a-z]$/, `${item.href} shows "${item.shortcut}"`);
    }
  });

  it('never share a key', () => {
    const seen = new Map<string, string>();
    for (const item of shown) {
      const owner = seen.get(item.shortcut!);
      assert.equal(owner, undefined, `${item.shortcut} is claimed by ${owner} and ${item.href}`);
      seen.set(item.shortcut!, item.href);
    }
  });

  it('cover the counter tools a teller lives in', () => {
    const hrefs = new Set(shown.map((item) => item.href));
    for (const href of ['/counter/machine', '/counter/usdt', '/counter/remittance']) {
      assert.ok(hrefs.has(href), `${href} has a shortcut`);
    }
  });
});
