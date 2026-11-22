import './support/test-env.ts';

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { toVoiceNote } from '../src/modules/whatsapp/voice-note.ts';

/**
 * A recording from the browser made into the voice note WhatsApp plays on
 * every phone: Opus in Ogg. Needs ffmpeg, as the server's image has; skipped
 * on a machine without it (FFMPEG_PATH points to one elsewhere).
 */

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const present = spawnSync(ffmpeg, ['-version']).status === 0;

/** Two seconds of a tone, recorded as Chrome records: Opus in WebM. */
function chromeRecording(): Buffer {
  const made = spawnSync(
    ffmpeg,
    ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'libopus', '-f', 'webm', 'pipe:1'],
    { maxBuffer: 10 * 1024 * 1024 },
  );
  return made.stdout;
}

describe('a voice note from the browser', { skip: !present && 'ffmpeg is not installed here' }, () => {
  it('comes out as Opus in Ogg, which WhatsApp plays as a voice note', async () => {
    const recording = chromeRecording();
    assert.ok(recording.length > 1000);
    const note = await toVoiceNote(recording);
    assert.equal(note.subarray(0, 4).toString('latin1'), 'OggS');
    assert.ok(note.includes(Buffer.from('OpusHead')), 'an Opus stream');
  });

  it('refuses what is not a recording', async () => {
    await assert.rejects(toVoiceNote(Buffer.from('not a recording at all, just words')));
    await assert.rejects(toVoiceNote(Buffer.alloc(0)));
  });
});
