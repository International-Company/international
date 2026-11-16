import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  changeRefusal,
  changesAllowed,
  DELETE_WINDOW_MS,
  EDIT_WINDOW_MS,
  type SentMessage,
} from '../src/modules/whatsapp/message-change.ts';

const NOW = Date.parse('2026-11-16T12:00:00Z');
const sent = (patch: Partial<SentMessage> = {}): SentMessage => ({
  ours: true,
  waId: 'ABC',
  mediaKind: null,
  deletedAt: null,
  createdAt: new Date(NOW - 60_000),
  ...patch,
});

describe('a message the office sent, put right', () => {
  it('can be edited and deleted just after it went', () => {
    assert.deepEqual(changesAllowed(sent(), NOW), { editable: true, deletable: true });
  });

  it('is never the customer’s', () => {
    assert.equal(changeRefusal(sent({ ours: false }), 'delete', NOW), 'errors.inboxNotOurs');
  });

  it('needs WhatsApp’s id for it', () => {
    assert.equal(changeRefusal(sent({ waId: null }), 'edit', NOW), 'errors.inboxCannotChange');
  });

  it('edits only words; a photo is deleted instead', () => {
    const photo = sent({ mediaKind: 'image' });
    assert.equal(changeRefusal(photo, 'edit', NOW), 'errors.inboxEditMedia');
    assert.equal(changeRefusal(photo, 'delete', NOW), null);
  });

  it('is edited only within WhatsApp’s quarter of an hour', () => {
    const late = sent({ createdAt: new Date(NOW - EDIT_WINDOW_MS - 1) });
    assert.equal(changeRefusal(late, 'edit', NOW), 'errors.inboxEditTooLate');
    assert.equal(changeRefusal(late, 'delete', NOW), null);
  });

  it('is deleted for everyone only within about two days', () => {
    const old = sent({ createdAt: new Date(NOW - DELETE_WINDOW_MS - 1) });
    assert.deepEqual(changesAllowed(old, NOW), { editable: false, deletable: false });
    assert.equal(changeRefusal(old, 'delete', NOW), 'errors.inboxDeleteTooLate');
  });

  it('is not changed again once deleted', () => {
    assert.equal(
      changeRefusal(sent({ deletedAt: new Date(NOW) }), 'delete', NOW),
      'errors.inboxAlreadyDeleted',
    );
  });
});
