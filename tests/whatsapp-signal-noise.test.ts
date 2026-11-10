// Must precede the service import — see the note in that file.
import './support/test-env.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isOwnDecryptFailure, isSignalNoise } from '../src/modules/whatsapp/signal-noise.ts';

describe('what is kept out of the log', () => {
  it('takes the encryption library’s own lines, including those that print keys', () => {
    for (const line of [
      'Session error:Error: Bad MAC',
      'Failed to decrypt message with any known session...',
      'Closing session:',
      'Removing old closed session:',
    ]) {
      assert.equal(isSignalNoise(line), true, line);
    }
  });

  it('leaves everything else, and a line that only mentions it', () => {
    assert.equal(isSignalNoise('{"level":"error","message":"Could not announce a deal"}'), false);
    assert.equal(isSignalNoise('A note about Session error: in passing'), false);
    assert.equal(isSignalNoise({ message: 'Session error:' }), false);
  });

  it('hides a failure to read one’s own message, never a customer’s', () => {
    const message = 'failed to decrypt message';
    assert.equal(isOwnDecryptFailure({ key: { fromMe: true } }, message), true);
    assert.equal(isOwnDecryptFailure({ key: { fromMe: false } }, message), false);
    assert.equal(isOwnDecryptFailure({ key: { fromMe: true } }, 'something else'), false);
    assert.equal(isOwnDecryptFailure(null, message), false);
  });
});
