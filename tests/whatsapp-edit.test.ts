// Must precede the service import — see the note in that file.
import './support/test-env.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CORRECTION_HEAD,
  EDIT_WINDOW_MS,
  reannounceEdited,
  type EditedDeal,
  type ReannounceDeps,
} from '../src/modules/whatsapp/announce.ts';
import type { Shareable } from '../src/modules/exchange/share.service.ts';

const NOW = Date.parse('2026-11-14T12:00:00Z');

const deal = (patch: Partial<EditedDeal> = {}): EditedDeal => ({
  reference: 'TXN-1',
  type: 'USDT_RECEIVE',
  status: 'POSTED',
  createdAt: new Date(NOW - 5 * 60 * 1000),
  announcedChat: 'main@g.us',
  announcedMessageId: 'm1',
  copyChat: 'bank@g.us',
  copyMessageId: 'c1',
  ...patch,
});

const share = (patch: Partial<Shareable> = {}): Shareable => ({
  reference: 'TXN-1',
  type: 'USDT_RECEIVE',
  bankPayout: true,
  companyName: '',
  text: 'plain',
  phone: null,
  detailText: 'in full',
  copyText: 'copy',
  ...patch,
});

const fake = (patch: Partial<ReannounceDeps> = {}, message: Shareable | null = share()) => {
  const calls: string[] = [];
  const deps: ReannounceDeps = {
    load: async () => message,
    hasPhotos: async () => false,
    edit: async (chat, id, text) => {
      calls.push(`edit ${chat} ${id} ${text}`);
    },
    reply: async (chat, id, text) => {
      calls.push(`reply ${chat} ${id} ${text}`);
    },
    now: () => NOW,
    ...patch,
  };
  return { calls, deps };
};

describe('a deal’s messages, after its details were edited', () => {
  it('rewrites both in place while WhatsApp still allows it', async () => {
    const { calls, deps } = fake();
    assert.deepEqual(await reannounceEdited('t1', deal(), deps), ['EDITED', 'EDITED']);
    assert.deepEqual(calls, ['edit main@g.us m1 in full', 'edit bank@g.us c1 copy']);
  });

  it('corrects in a reply once the edit window has passed', async () => {
    const { calls, deps } = fake();
    const old = deal({ createdAt: new Date(NOW - EDIT_WINDOW_MS - 1000) });
    assert.deepEqual(await reannounceEdited('t1', old, deps), ['REPLIED', 'REPLIED']);
    assert.equal(calls[0], `reply main@g.us m1 ${CORRECTION_HEAD}\n\nin full`);
  });

  it('replies when the edit itself fails', async () => {
    const { calls, deps } = fake({
      edit: async () => {
        throw new Error('no');
      },
    });
    assert.deepEqual(await reannounceEdited('t1', deal({ copyChat: null }), deps), ['REPLIED']);
    assert.equal(calls.length, 1);
  });

  it('replies to a deal that went out under a photo: a caption is not edited here', async () => {
    const { calls, deps } = fake({ hasPhotos: async () => true });
    await reannounceEdited('t1', deal({ copyChat: null }), deps);
    assert.match(calls[0]!, /^reply /);
  });

  it('uses the plain lines when the office did not ask for details', async () => {
    const { calls, deps } = fake({}, share({ detailText: null }));
    await reannounceEdited('t1', deal({ copyChat: null }), deps);
    assert.deepEqual(calls, ['edit main@g.us m1 plain']);
  });

  it('touches nothing for a cancelled deal, or one never sent', async () => {
    const { calls, deps } = fake();
    await reannounceEdited('t1', deal({ status: 'REVERSED' }), deps);
    await reannounceEdited(
      't1',
      deal({ announcedChat: null, announcedMessageId: null, copyChat: null }),
      deps,
    );
    assert.deepEqual(calls, []);
  });
});
