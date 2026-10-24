import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ConfigService } from '@nestjs/config';
import { AiVoiceProviderError } from '../voice/ai-voice-provider';
import {
  DEFAULT_FILE_TIMEOUT_MS,
  DEFAULT_TRANSCRIBE_MODEL,
  HttpVoiceProvider,
  parseTranscript,
} from '../voice/http-voice-provider';
import { startStandin } from '../../../test/ai-tools/voice-standin-for-specs';
import { buildSrt } from '../tools/subtitles';
import { CAPTIONS_TOOL } from '../tools/captions.tool';
import { CLEAN_AUDIO_TOOL } from '../tools/clean-audio.tool';
import { readSeconds, minutesOf } from '../input/media-length';

/**
 * The adapter's two file calls (AITOOLS-04), run against the local stand-in
 * with the provider's wire shape, the pure parts (subtitle file, length
 * reader) on their own. NOT RUN against the real provider.
 */
function wav(seconds: number, tail = ''): Buffer {
  const rate = 8000;
  const size = Math.round(seconds * rate);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(36 + size, 4);
  head.write('WAVEfmt ', 8, 'latin1');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate, 28);
  head.writeUInt16LE(1, 32);
  head.writeUInt16LE(8, 34);
  head.write('data', 36, 'latin1');
  head.writeUInt32LE(size, 40);
  return Buffer.concat([head, Buffer.alloc(size, 128), Buffer.from(tail)]);
}

describe('AITOOLS-04: the AI provider seam, Captions and Clean audio', () => {
  let standin: Awaited<ReturnType<typeof startStandin>>;
  beforeAll(async () => {
    standin = await startStandin('spec-key');
  });
  afterAll(async () => {
    await new Promise<void>((r) => standin.server.close(() => r()));
  });
  beforeEach(() => {
    standin.state.transcribe.length = 0;
    standin.state.isolate.length = 0;
    standin.state.deletedTranscripts.length = 0;
    standin.state.deletedIsolations.length = 0;
  });
  const provider = (env: Record<string, string | undefined> = {}) =>
    new HttpVoiceProvider(
      new ConfigService({
        AI_VOICE_BASE_URL: `http://127.0.0.1:${standin.port}`,
        AI_VOICE_API_KEY: 'spec-key',
        ...env,
      }),
    );
  const file = (seconds: number, tail = '') => ({
    audio: wav(seconds, tail),
    contentType: 'audio/wav',
  });

  it('needs only a host and a key (no voice list), and is off without them', () => {
    expect(provider().fileToolsConfigured).toBe(true);
    expect(provider({ AI_VOICE_API_KEY: undefined }).fileToolsConfigured).toBe(
      false,
    );
    expect(provider({ AI_VOICE_BASE_URL: undefined }).fileToolsConfigured).toBe(
      false,
    );
    expect(CAPTIONS_TOOL.enabled(provider())).toBe(true);
    expect(
      CLEAN_AUDIO_TOOL.enabled(provider({ AI_VOICE_API_KEY: undefined })),
    ).toBe(false);
  });

  it('sends the file, the model, word times and the language, and reads the words, times, length and id', async () => {
    const t = await provider().transcribe({
      file: file(5),
      languageCode: 'yo',
    });
    expect(standin.state.transcribe).toEqual([
      expect.objectContaining({
        model: DEFAULT_TRANSCRIBE_MODEL,
        languageCode: 'yo',
        granularity: 'word',
        fileType: 'audio/wav',
      }),
    ]);
    expect(standin.state.transcribe[0].bytes).toBe(wav(5).length);
    expect(t.words).toHaveLength(10);
    expect(t.words[0]).toMatchObject({ text: 'word1', type: 'word', start: 0 });
    expect(t.durationSeconds).toBeCloseTo(5, 3);
    expect(t.id).toMatch(/^tr-\d+$/);
    // No language: none is sent.
    await provider().transcribe({ file: file(2), languageCode: null });
    expect(standin.state.transcribe[1].languageCode).toBeNull();
    // The model is a setting.
    await provider({ AI_VOICE_TRANSCRIBE_MODEL: 'scribe_v9' }).transcribe({
      file: file(2),
      languageCode: null,
    });
    expect(standin.state.transcribe[2].model).toBe('scribe_v9');
  });

  it("deletes the provider's copies, and never throws when it cannot", async () => {
    const p = provider();
    const open = standin.openTranscripts();
    const t = await p.transcribe({ file: file(2), languageCode: null });
    expect(standin.openTranscripts()).toBe(open + 1);
    await expect(p.deleteTranscript(t.id!)).resolves.toBe('deleted');
    expect(standin.state.deletedTranscripts).toEqual([t.id]);
    expect(standin.openTranscripts()).toBe(open);
    const c = await p.isolateVoice({ file: file(2) });
    expect(c.contentType).toBe('audio/mpeg');
    expect(c.historyId).toMatch(/^iso-\d+$/);
    await expect(p.deleteIsolation(c.historyId!)).resolves.toBe('deleted');
    expect(standin.state.deletedIsolations).toEqual([c.historyId]);
    // Round 2: a delete says how the try went (it used to say nothing, which
    // hid the provider's 404 for a copy not stored yet). A copy that is not
    // there is `not_found`; a refused key is `failed`; neither throws.
    await expect(p.deleteTranscript('tr-none')).resolves.toBe('not_found');
    await expect(p.deleteIsolation('iso-none')).resolves.toBe('not_found');
    await expect(
      provider({ AI_VOICE_API_KEY: 'wrong' }).deleteTranscript('x'),
    ).resolves.toBe('failed');
  });

  it("HIGH 3 (round 2): the cleaned item's id is the audio-isolation-id header, as the real provider sends it; history-item-id is not read", async () => {
    const answer = (headers: Record<string, string>) =>
      new Promise<{ server: Server; port: number }>((resolve) => {
        const server = createServer((req, res) => {
          req.resume();
          req.on('end', () => {
            res.writeHead(200, { 'content-type': 'audio/mpeg', ...headers });
            res.end(Buffer.alloc(64, 1));
          });
        });
        server.listen(0, '127.0.0.1', () =>
          resolve({ server, port: (server.address() as AddressInfo).port }),
        );
      });
    const real = await answer({ 'audio-isolation-id': 'abc_123-XYZ' });
    const old = await answer({ 'history-item-id': 'old-name-1' });
    try {
      const cleanedReal = await provider({
        AI_VOICE_BASE_URL: `http://127.0.0.1:${real.port}`,
      }).isolateVoice({ file: file(2) });
      expect(cleanedReal.historyId).toBe('abc_123-XYZ');
      const cleanedOld = await provider({
        AI_VOICE_BASE_URL: `http://127.0.0.1:${old.port}`,
      }).isolateVoice({ file: file(2) });
      expect(cleanedOld.historyId).toBeNull();
    } finally {
      await new Promise((r) => real.server.close(r));
      await new Promise((r) => old.server.close(r));
    }
  });

  it('answers a provider fault as the other calls do: 429 and 5xx can be tried again, any other refusal cannot, a web page is not an answer', async () => {
    const p = provider();
    const kind = async (tail: string, call: 'stt' | 'iso') => {
      try {
        if (call === 'stt')
          await p.transcribe({ file: file(1, tail), languageCode: null });
        else await p.isolateVoice({ file: file(1, tail) });
      } catch (e) {
        const err = e as AiVoiceProviderError;
        return [err.kind, err.status] as const;
      }
      return null;
    };
    for (const call of ['stt', 'iso'] as const) {
      expect(await kind('[[fail]]', call)).toEqual(['unavailable', 500]);
      expect(await kind('[[reject]]', call)).toEqual(['rejected', 422]);
      expect(await kind('[[status:402]]', call)).toEqual(['rejected', 402]);
      expect(await kind('[[status:429]]', call)).toEqual(['unavailable', 429]);
      expect(await kind('[[html]]', call)).toEqual(['unavailable', undefined]);
    }
    await expect(
      provider({ AI_VOICE_API_KEY: 'wrong' }).transcribe({
        file: file(1),
        languageCode: null,
      }),
    ).rejects.toMatchObject({ kind: 'rejected', status: 401 });
  });

  it('honours its configured timeout (the file call is not cut at 300 seconds, and not kept past its own deadline)', async () => {
    expect(DEFAULT_FILE_TIMEOUT_MS).toBe(600_000);
    const quick = provider({ AI_VOICE_FILE_TIMEOUT_MS: '1500' });
    const started = Date.now();
    await expect(
      quick.transcribe({ file: file(1, '[[slow:4000]]'), languageCode: null }),
    ).rejects.toMatchObject({ kind: 'unavailable' });
    expect(Date.now() - started).toBeLessThan(3500);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1400);
    await expect(
      quick.isolateVoice({ file: file(1, '[[slow:4000]]') }),
    ).rejects.toMatchObject({ kind: 'unavailable' });
    // A slow answer inside the deadline is kept.
    const ok = await quick.transcribe({
      file: file(1, '[[slow:600]]'),
      languageCode: null,
    });
    expect(ok.words.length).toBeGreaterThan(0);
    // An abort ends the call.
    const ac = new AbortController();
    const abortAt = Date.now();
    setTimeout(() => ac.abort(), 300);
    await expect(
      provider().transcribe(
        { file: file(1, '[[slow:4000]]'), languageCode: null },
        { signal: ac.signal },
      ),
    ).rejects.toMatchObject({ kind: 'unavailable' });
    expect(Date.now() - abortAt).toBeLessThan(2000);
  });

  it('reads a transcript answer strictly: no text field is not a transcript; empty text is no speech', () => {
    expect(() => parseTranscript(Buffer.from('<html>'))).toThrow(
      AiVoiceProviderError,
    );
    expect(() => parseTranscript(Buffer.from('{"words":[]}'))).toThrow(
      AiVoiceProviderError,
    );
    const none = parseTranscript(
      Buffer.from('{"text":"","words":[],"audio_duration_secs":4}'),
    );
    expect(none).toEqual({ text: '', words: [], durationSeconds: 4, id: null });
    const bad = parseTranscript(
      Buffer.from(
        JSON.stringify({
          text: 'a',
          words: [
            { text: 'a', start: 'x', end: 1 },
            { text: 'b', start: 0, end: 1 },
          ],
          audio_duration_secs: -1,
          transcription_id: '../x',
        }),
      ),
    );
    expect(bad.words).toHaveLength(1);
    expect(bad.durationSeconds).toBeNull();
    expect(bad.id).toBeNull();
  });

  it('builds the subtitle file from the word times: cues end at a sentence, a pause, eight words or four seconds', () => {
    const w = (text: string, start: number, end: number, type = 'word') => ({
      text,
      type,
      start,
      end,
    });
    expect(
      buildSrt(
        [
          w('Hello', 0, 0.4),
          w(' ', 0.4, 0.5, 'spacing'),
          w('there.', 0.5, 1),
          w('Next', 1.2, 1.5),
          w('one', 1.5, 2),
          w('after', 5, 5.5),
          w('a', 5.5, 5.6),
          w('pause', 5.6, 6),
        ],
        { text: 'x', durationSeconds: 6 },
      ),
    ).toBe(
      '1\n00:00:00,000 --> 00:00:01,000\nHello there.\n\n' +
        '2\n00:00:01,200 --> 00:00:02,000\nNext one\n\n' +
        '3\n00:00:05,000 --> 00:00:06,000\nafter a pause\n',
    );
    const eight = Array.from({ length: 9 }, (_, i) =>
      w(`w${i}`, i * 0.2, i * 0.2 + 0.1),
    );
    expect(
      buildSrt(eight, { text: '', durationSeconds: 2 }).split('\n\n'),
    ).toHaveLength(2);
    expect(buildSrt([], { text: '', durationSeconds: 2 })).toBe('');
    // Words with no times still make one cue from the text.
    expect(buildSrt([], { text: 'just words', durationSeconds: 3 })).toBe(
      '1\n00:00:00,000 --> 00:00:03,000\njust words\n',
    );
    expect(
      buildSrt([w('late', 3725.5, 3726)], {
        text: 'late',
        durationSeconds: 3726,
      }),
    ).toContain('01:02:05,500 --> 01:02:06,000');
  });

  it('reads a length from the file itself and rounds the minutes up, at least 1', async () => {
    expect(await readSeconds(wav(90))).toBeCloseTo(90, 2);
    // The declared type plays no part: the bytes name the container.
    expect(await readSeconds(wav(10))).toBeCloseTo(10, 2);
    expect(await readSeconds(Buffer.from('not a recording'))).toBeNull();
    expect(await readSeconds(Buffer.alloc(0))).toBeNull();
    expect(await readSeconds(Buffer.alloc(5000))).toBeNull();
    // Round 2 (LOW 6): 0.5 s of container padding is forgiven, so a "1:00"
    // clip that reads 60.06 s is one minute (this list used to expect 2 for
    // 60.01, which pinned the defect). Anything over the tolerance rounds up.
    expect(
      [0.2, 1, 60, 60.01, 60.06, 60.5, 60.6, 90, 120, 121].map(minutesOf),
    ).toEqual([1, 1, 1, 1, 1, 1, 2, 2, 2, 3]);
  });
});
