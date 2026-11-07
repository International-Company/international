// Must precede the service import — see the note in that file.
import './support/test-env.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { composeReconciliation } from '../src/modules/tiktok/tiktok-message.ts';
import { handleReconcile } from '../src/modules/whatsapp/tiktok-reconcile.ts';
import type { IncomingText } from '../src/modules/whatsapp/whatsapp.service.ts';

const U = 100_000_000n;
const rows = [
  { at: '09:15', account: '12345', beneficiaryName: 'محمد', amount: 100n * U, currency: 'USD', payoutAmount: 255n * U },
  { at: '11:40', account: '67890', beneficiaryName: 'سامي', amount: 50n * U, currency: 'USD', payoutAmount: 127n * U },
];

describe('the TikTok reconciliation', () => {
  it('says the dollars withdrawn that day, and nothing else', () => {
    assert.equal(
      composeReconciliation(rows, '2026-11-07', '14:20'),
      ['📋 *مطابقة تيكتوك*', '2026-11-07 — حتى الساعة 14:20', '', 'المجموع: *150 دولار*'].join('\n'),
    );
  });

  it('says nothing was withdrawn on a day with none', () => {
    assert.match(composeReconciliation([], '2026-11-07', '08:00'), /المجموع: \*0 دولار\*/);
  });

  const incoming = (chat: string, text: string) =>
    ({ chat, text, sender: null, senderPhone: null, message: {}, account: 'main' }) as unknown as IncomingText;

  const run = async (chat: string, text: string) => {
    const sent: string[] = [];
    const outcome = await handleReconcile(incoming(chat, text), {
      group: async () => 'tiktok@g.us',
      rows: async () => rows,
      reply: async (_m, body) => {
        sent.push(body);
      },
      now: () => new Date(2026, 10, 7, 14, 20),
    });
    return { outcome, sent };
  };

  it('answers the code in the TikTok group', async () => {
    const { outcome, sent } = await run('tiktok@g.us', '  #مطابقة ');
    assert.equal(outcome, 'SENT');
    assert.match(sent[0]!, /150 دولار/);
  });

  it('ignores it anywhere else, or with words after it', async () => {
    assert.equal((await run('other@g.us', '#مطابقة')).outcome, 'IGNORED');
    assert.equal((await run('tiktok@g.us', '#مطابقة أحمد')).outcome, 'IGNORED');
    assert.equal((await run('tiktok@g.us', 'مطابقة')).outcome, 'IGNORED');
  });
});
