import 'server-only';
import { spawn } from 'node:child_process';
import { errors } from '@/core/errors/app-error';
import { createLogger } from '@/core/logger/logger';

const log = createLogger('whatsapp:voice');

/** A voice note longer than this is a recording left running, not a message. */
export const MAX_VOICE_BYTES = 3 * 1024 * 1024;

/**
 * A recording from the browser, made into a WhatsApp voice note.
 *
 * Browsers record Opus in WebM (Chrome, Edge) or in Ogg (Firefox), and MP4 on
 * Safari. WhatsApp plays a voice note — the green one with the waveform, on
 * every phone, iPhones too — only as Opus in Ogg, mono, at 48 kHz. So every
 * recording goes through ffmpeg once, whatever it came in as.
 *
 * ffmpeg is installed in the server's image; FFMPEG_PATH points elsewhere when
 * it lives somewhere else.
 */
export async function toVoiceNote(input: Buffer): Promise<Buffer> {
  if (input.length === 0 || input.length > MAX_VOICE_BYTES) {
    throw errors.precondition('Not a usable recording', 'errors.voiceInvalid');
  }
  const binary = process.env.FFMPEG_PATH || 'ffmpeg';
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(
      binary,
      ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip', '-f', 'ogg', 'pipe:1'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const out: Buffer[] = [];
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString().slice(0, 500);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      log.error('ffmpeg could not be started', { error });
      reject(errors.precondition('The server cannot make voice notes', 'errors.voiceUnavailable'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const result = Buffer.concat(out);
      if (code !== 0 || result.length === 0) {
        log.warn('A recording could not be made a voice note', { code, stderr });
        reject(errors.precondition('Not a usable recording', 'errors.voiceInvalid'));
        return;
      }
      resolve(result);
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}
