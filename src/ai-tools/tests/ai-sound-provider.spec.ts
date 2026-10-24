import { ConfigService } from '@nestjs/config';
import { AiVoiceProviderError } from '../voice/ai-voice-provider';
import {
  DEFAULT_MUSIC_TIMEOUT_MS,
  HttpVoiceProvider,
} from '../voice/http-voice-provider';
import { startStandin } from '../../../test/ai-tools/voice-standin-for-specs';

/**
 * The adapter's two prompt calls (AITOOLS-03), run against the local stand-in
 * with the provider's wire shape. NOT RUN against the real provider.
 */
const VOICES = JSON.stringify([
  {
    id: 'ada',
    name: 'Ada',
    description: 'Warm, Nigerian English',
    providerVoiceId: 'stand-in-ada',
  },
]);
const FRAME_SECONDS = 1152 / 44100;

describe('AITOOLS-03: the AI provider seam, Sound effect and Music track', () => {
  let standin: Awaited<ReturnType<typeof startStandin>>;
  beforeAll(async () => {
    standin = await startStandin('spec-key');
  });
  afterAll(async () => {
    await new Promise<void>((r) => standin.server.close(() => r()));
  });
  beforeEach(() => {
    standin.state.sfx.length = 0;
    standin.state.music.length = 0;
  });

  const provider = (env: Record<string, string | undefined> = {}) =>
    new HttpVoiceProvider(
      new ConfigService({
        AI_VOICE_BASE_URL: `http://127.0.0.1:${standin.port}`,
        AI_VOICE_API_KEY: 'spec-key',
        AI_VOICE_VOICES: VOICES,
        ...env,
      }),
    );
  const seconds = (audio: Buffer) => (audio.length / 417) * FRAME_SECONDS;

  it('makes a sound effect of the asked length, and sends no length when none is asked', async () => {
    const p = provider();
    const out = await p.makeSoundEffect({
      prompt: 'A door creaking open.',
      durationSeconds: 3,
    });
    expect(out.contentType).toBe('audio/mpeg');
    expect(out.audio.subarray(0, 2).toString('hex')).toBe('fffb');
    expect(seconds(out.audio)).toBeGreaterThan(2.9);
    expect(seconds(out.audio)).toBeLessThan(3.1);
    await p.makeSoundEffect({ prompt: 'A door.', durationSeconds: null });
    expect(standin.state.sfx).toEqual([3, null]);
  });

  it('makes a track of the asked length and switch, and sends neither when none is asked', async () => {
    const p = provider();
    const out = await p.makeMusic({
      prompt: 'A slow piano piece.',
      lengthSeconds: 12,
      instrumental: true,
    });
    expect(seconds(out.audio)).toBeGreaterThan(11.9);
    expect(seconds(out.audio)).toBeLessThan(12.1);
    await p.makeMusic({
      prompt: 'A slow piano piece.',
      lengthSeconds: null,
      instrumental: false,
    });
    expect(standin.state.music).toEqual([
      { lengthMs: 12000, instrumental: true },
      { lengthMs: null, instrumental: false },
    ]);
  });

  it.each([
    ['500', '[[fail]]', 'unavailable'],
    ['422', '[[reject]]', 'rejected'],
    ['a page, not audio', '[[html]]', 'unavailable'],
  ])(
    'maps a provider answer of %s to %s (both calls)',
    async (_n, marker, kind) => {
      const p = provider();
      await expect(
        p.makeSoundEffect({ prompt: `Rain ${marker}`, durationSeconds: null }),
      ).rejects.toMatchObject({ kind });
      await expect(
        p.makeMusic({
          prompt: `Rain ${marker}`,
          lengthSeconds: null,
          instrumental: false,
        }),
      ).rejects.toMatchObject({ kind });
    },
  );

  it('a length the provider refuses is rejected, not retried', async () => {
    await expect(
      provider().makeSoundEffect({ prompt: 'Rain', durationSeconds: 45 }),
    ).rejects.toMatchObject({ kind: 'rejected' });
    await expect(
      provider().makeMusic({
        prompt: 'Rain',
        lengthSeconds: 2,
        instrumental: false,
      }),
    ).rejects.toBeInstanceOf(AiVoiceProviderError);
  });

  it('a track has its own, longer timeout: a call the speech timeout would cut off still finishes, and its own timeout can be set', async () => {
    // The speech timeout is one second; the track timeout is its default (10 minutes).
    expect(DEFAULT_MUSIC_TIMEOUT_MS).toBe(600_000);
    const p = provider({ AI_VOICE_TIMEOUT_MS: '1000' });
    await expect(
      p.makeSoundEffect({
        prompt: 'Rain [[slow:1500]]',
        durationSeconds: null,
      }),
    ).rejects.toMatchObject({ kind: 'unavailable' });
    const out = await p.makeMusic({
      prompt: 'Rain [[slow:1500]]',
      lengthSeconds: null,
      instrumental: false,
    });
    expect(out.audio.length).toBeGreaterThan(400);
    // Set short, the track's own timeout cuts the call off.
    await expect(
      provider({ AI_VOICE_MUSIC_TIMEOUT_MS: '1000' }).makeMusic({
        prompt: 'Rain [[slow:1500]]',
        lengthSeconds: null,
        instrumental: false,
      }),
    ).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('is refused when the provider is not set up, and the error carries neither the words nor a provider answer', async () => {
    const off = provider({ AI_VOICE_BASE_URL: undefined });
    expect(off.configured).toBe(false);
    const err = await off
      .makeSoundEffect({ prompt: 'secret words', durationSeconds: null })
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(AiVoiceProviderError);
    expect((err as Error).message).not.toContain('secret');
  });
});
