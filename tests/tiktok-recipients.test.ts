import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseTiktokRecipients } from '../src/modules/tiktok/tiktok-message.ts';

describe('whom TikTok withdrawals are sent to', () => {
  it('reads each name with its group', () => {
    const stored = JSON.stringify([
      { name: 'أبو محمد', group: { id: '120363000000000011@g.us', name: 'سحوبات أبو محمد' } },
      { name: 'سامي', group: { id: '120363000000000012@g.us', name: 'سحوبات سامي' } },
    ]);
    assert.deepEqual(
      parseTiktokRecipients(stored).map((entry) => [entry.name, entry.group.id]),
      [
        ['أبو محمد', '120363000000000011@g.us'],
        ['سامي', '120363000000000012@g.us'],
      ],
    );
  });

  it('leaves out a name without a group, a group that is not one, and a name given twice', () => {
    const stored = JSON.stringify([
      { name: '  ', group: { id: '1@g.us' } },
      { name: 'بلا مجموعة', group: { id: '' } },
      { name: 'رقم شخص', group: { id: '970599000000@s.whatsapp.net' } },
      { name: 'سامي', group: { id: '2@g.us' } },
      { name: 'سامي', group: { id: '3@g.us' } },
    ]);
    assert.deepEqual(parseTiktokRecipients(stored).map((entry) => entry.group.id), ['2@g.us']);
  });

  it('reads nothing from what cannot be read', () => {
    assert.deepEqual(parseTiktokRecipients(''), []);
    assert.deepEqual(parseTiktokRecipients('not json'), []);
    assert.deepEqual(parseTiktokRecipients('{"a":1}'), []);
  });
});
