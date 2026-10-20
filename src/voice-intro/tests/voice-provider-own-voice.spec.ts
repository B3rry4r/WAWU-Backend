// The own-voice and name-preview calls of the voice adapter (VOICE-01), run
// against the local stand-in (scripts/dev/voice-standin.cjs). NOT RUN against
// the real provider: a provider key set on the Hub unblocks that.
import { ConfigService } from '@nestjs/config';
import { AiVoiceProviderError } from '../../ai-tools/voice/ai-voice-provider';
import { HttpVoiceProvider } from '../../ai-tools/voice/http-voice-provider';
import {
  startStandin,
  type StandinHandle,
} from '../../../test/ai-tools/voice-standin-for-specs';

const KEY = 'voice01-adapter-key';
const VOICES = JSON.stringify([
  {
    id: 'ada',
    name: 'Ada',
    description: 'Warm',
    providerVoiceId: 'stand-in-ada',
  },
]);

describe('VOICE-01: the voice adapter, name preview and own voice', () => {
  let standin: StandinHandle;
  let provider: HttpVoiceProvider;
  const sample = (text = 'a recording') => ({
    audio: Buffer.from(text),
    contentType: 'audio/mp4',
  });

  beforeAll(async () => {
    // Its own port when the run gives one, so a connection kept open to an
    // earlier spec's stand-in on the same port is never reused.
    if (process.env.VOICE_STANDIN_PORT)
      process.env.VOICE_STANDIN_PORT = String(
        Number(process.env.VOICE_STANDIN_PORT) + 1,
      );
    standin = await startStandin(KEY);
    const values: Record<string, string> = {
      AI_VOICE_BASE_URL: `http://127.0.0.1:${standin.port}`,
      AI_VOICE_API_KEY: KEY,
      AI_VOICE_VOICES: VOICES,
    };
    provider = new HttpVoiceProvider({
      get: (k: string) => values[k],
    } as unknown as ConfigService);
  });
  afterAll(async () => {
    if (process.env.VOICE_STANDIN_PORT)
      process.env.VOICE_STANDIN_PORT = String(
        Number(process.env.VOICE_STANDIN_PORT) - 1,
      );
    await new Promise<void>((r) => standin.server.close(() => r()));
  });

  it('says a name in the studio voice (the first listed)', async () => {
    const out = await provider.previewName({ text: 'Ah-DEH-oh-lah' });
    expect(out.contentType).toBe('audio/mpeg');
    expect(out.audio.length).toBeGreaterThan(0);
  });

  it('makes a voice from the sample, speaks with it and takes it out again', async () => {
    const cloned = standin.state.cloned;
    const out = await provider.speakInOwnVoice({
      sample: sample(),
      text: 'Hello from me.',
    });
    expect(out.audio.length).toBeGreaterThan(0);
    expect(standin.state.cloned).toBe(cloned + 1);
    expect(standin.openClones()).toBe(0);
  });

  it('takes the voice out even when the speech fails', async () => {
    await expect(
      provider.speakInOwnVoice({ sample: sample(), text: 'No. [[fail]]' }),
    ).rejects.toMatchObject({ kind: 'unavailable' });
    expect(standin.openClones()).toBe(0);
  });

  it('tells a refusal of the sample from a provider that is down', async () => {
    await expect(
      provider.speakInOwnVoice({
        sample: sample('[[sample-reject]]'),
        text: 'Hi',
      }),
    ).rejects.toMatchObject({ kind: 'rejected' });
    await expect(
      provider.speakInOwnVoice({
        sample: sample('[[sample-fail]]'),
        text: 'Hi',
      }),
    ).rejects.toMatchObject({ kind: 'unavailable' });
    await expect(
      provider.speakInOwnVoice({
        sample: sample('[[sample-fail]]'),
        text: 'Hi',
      }),
    ).rejects.toBeInstanceOf(AiVoiceProviderError);
    expect(standin.openClones()).toBe(0);
  });

  it('is off, and calls nothing, until the key and the host are set', async () => {
    const off = new HttpVoiceProvider({
      get: () => undefined,
    } as unknown as ConfigService);
    expect(off.configured).toBe(false);
    await expect(off.previewName({ text: 'Ada' })).rejects.toMatchObject({
      kind: 'rejected',
    });
    await expect(
      off.speakInOwnVoice({ sample: sample(), text: 'Hi' }),
    ).rejects.toMatchObject({ kind: 'rejected' });
  });
});
