import { ConfigService } from '@nestjs/config';
import { AiVoiceProviderError } from '../voice/ai-voice-provider';
import {
  HttpVoiceProvider,
  parseVoiceCatalogue,
} from '../voice/http-voice-provider';
import { jobIdFor } from '../ai-job.service';
import { startStandin } from '../../../test/ai-tools/voice-standin-for-specs';

/**
 * The adapter to the AI voice provider (AITOOLS-01), run against the local
 * stand-in with the provider's wire shape. NOT RUN against the real provider.
 */
const VOICES = JSON.stringify([
  {
    id: 'ada',
    name: 'Ada',
    description: 'Warm, Nigerian English',
    providerVoiceId: 'stand-in-ada',
  },
]);

describe('AITOOLS-01: the AI voice provider seam', () => {
  let standin: Awaited<ReturnType<typeof startStandin>>;
  beforeAll(async () => {
    standin = await startStandin('spec-key');
  });
  afterAll(async () => {
    await new Promise<void>((r) => standin.server.close(() => r()));
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

  it('makes audio for a listed voice, and shows a person only the WAWU voice, never the provider id', async () => {
    const p = provider();
    expect(p.configured).toBe(true);
    expect(p.voices()).toEqual([
      { id: 'ada', name: 'Ada', description: 'Warm, Nigerian English' },
    ]);
    const out = await p.speak({ voiceId: 'ada', text: 'Hello there, friend.' });
    expect(out.contentType).toBe('audio/mpeg');
    expect(out.audio.length).toBeGreaterThan(400);
    expect(out.audio.subarray(0, 2).toString('hex')).toBe('fffb');
  });

  it.each([
    ['500', '[[fail]]', 'unavailable'],
    ['422', '[[reject]]', 'rejected'],
    ['a page, not audio', '[[html]]', 'unavailable'],
  ])('maps a provider answer of %s to %s', async (_n, marker, kind) => {
    await expect(
      provider().speak({ voiceId: 'ada', text: `Words ${marker}` }),
    ).rejects.toMatchObject({ name: 'AiVoiceProviderError', kind });
  });

  it('a wrong key is a refusal, an unknown voice never leaves the Hub, and a slow answer past the time limit is unavailable', async () => {
    await expect(
      provider({ AI_VOICE_API_KEY: 'wrong' }).speak({
        voiceId: 'ada',
        text: 'x',
      }),
    ).rejects.toMatchObject({ kind: 'rejected' });
    const calls = standin.state.calls;
    await expect(
      provider().speak({ voiceId: 'stand-in-ada', text: 'x' }),
    ).rejects.toBeInstanceOf(AiVoiceProviderError);
    expect(standin.state.calls).toBe(calls);
    await expect(
      provider({ AI_VOICE_TIMEOUT_MS: '1000' }).speak({
        voiceId: 'ada',
        text: 'Words [[slow:2500]]',
      }),
    ).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('a provider that cannot be reached is unavailable, and the error holds neither the text nor the key', async () => {
    const err = await provider({ AI_VOICE_BASE_URL: 'http://127.0.0.1:9' })
      .speak({ voiceId: 'ada', text: 'A secret script' })
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(AiVoiceProviderError);
    expect((err as AiVoiceProviderError).kind).toBe('unavailable');
    expect(String((err as Error).message)).not.toMatch(/secret|spec-key/);
  });

  it('is off until a host, a key and a valid voice list are all set; no host is built in', () => {
    expect(provider({ AI_VOICE_BASE_URL: undefined }).configured).toBe(false);
    expect(provider({ AI_VOICE_API_KEY: '' }).configured).toBe(false);
    expect(provider({ AI_VOICE_VOICES: undefined }).configured).toBe(false);
    expect(provider({ AI_VOICE_VOICES: '[]' }).configured).toBe(false);
    expect(provider({ AI_VOICE_VOICES: 'not json' }).configured).toBe(false);
    expect(provider({ AI_VOICE_BASE_URL: 'ftp://x' }).configured).toBe(false);
    expect(new HttpVoiceProvider(new ConfigService({})).configured).toBe(false);
  });

  it('reads the voice list strictly', () => {
    const ok = {
      id: 'ada',
      name: 'Ada',
      description: '',
      providerVoiceId: 'p1',
    };
    expect(parseVoiceCatalogue(JSON.stringify([ok])).voices).toHaveLength(1);
    expect(
      parseVoiceCatalogue(JSON.stringify([ok, ok])).problem,
    ).not.toBeNull();
    expect(
      parseVoiceCatalogue(JSON.stringify([{ ...ok, id: 'Bad Id' }])).problem,
    ).not.toBeNull();
    expect(
      parseVoiceCatalogue(JSON.stringify([{ ...ok, providerVoiceId: '' }]))
        .problem,
    ).not.toBeNull();
    expect(parseVoiceCatalogue('{}').problem).toBe('is not a list');
    expect(parseVoiceCatalogue(undefined)).toEqual({
      voices: [],
      problem: null,
    });
  });
});

describe('AITOOLS-01: a job id is made from the person and the key', () => {
  it('is the same for the same pair, different for any other, and a UUID', () => {
    const a = jobIdFor(
      '11111111-1111-4111-8111-111111111111',
      'key-number-one',
    );
    expect(a).toBe(
      jobIdFor('11111111-1111-4111-8111-111111111111', 'key-number-one'),
    );
    expect(a).not.toBe(
      jobIdFor('11111111-1111-4111-8111-111111111111', 'key-number-two'),
    );
    expect(a).not.toBe(
      jobIdFor('22222222-2222-4222-8222-222222222222', 'key-number-one'),
    );
    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
