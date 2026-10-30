import { Readable } from 'node:stream';
import { ConfigService } from '@nestjs/config';
import { AiVoiceProviderError } from '../voice/ai-voice-provider';
import { HttpVoiceProvider } from '../voice/http-voice-provider';
import { startStandin } from '../../../test/ai-tools/voice-standin-for-specs';
import { mp3File, wavFile } from '../../../test/ai-tools/media-fixtures';
import { readZip } from '../music/zip-reader';

/**
 * The adapter's calls for AITOOLS-11 and AITOOLS-12 (Voice changer, Dialogue, a saved clone, Music for a video, Split a
 * song) against the local stand-in with the provider's wire shape (docs/elevenlabs/API-FACTS.md, "Studio 2"). NO real
 * provider call: the owner's credits are not bought yet (each tool's one proof call is NOT RUN, waiting for credits).
 */
describe('AITOOLS-11, AITOOLS-12: the AI provider seam, voices and music', () => {
  let standin: Awaited<ReturnType<typeof startStandin>>;
  beforeAll(async () => {
    standin = await startStandin('spec-key');
  });
  afterAll(async () => {
    await new Promise<void>((r) => standin.server.close(() => r()));
  });
  beforeEach(() => {
    const s = standin.state;
    s.voiceChanges.length = 0;
    s.dialogues.length = 0;
    s.cloneNames.length = 0;
    s.videoMusic.length = 0;
    s.stems.length = 0;
    s.voices.length = 0;
  });
  const provider = (voices = true) =>
    new HttpVoiceProvider(
      new ConfigService({
        AI_VOICE_BASE_URL: `http://127.0.0.1:${standin.port}`,
        AI_VOICE_API_KEY: 'spec-key',
        ...(voices
          ? {
              AI_VOICE_VOICES: JSON.stringify([
                {
                  id: 'ada',
                  name: 'Ada',
                  description: 'Warm',
                  providerVoiceId: 'stand-in-ada',
                },
                {
                  id: 'tunde',
                  name: 'Tunde',
                  description: 'Deep',
                  providerVoiceId: 'stand-in-tunde',
                },
              ]),
            }
          : {}),
      }),
    );
  const file = (audio: Buffer, contentType = 'audio/mpeg') => ({
    audio,
    contentType,
  });
  const kind = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      if (e instanceof AiVoiceProviderError)
        return { kind: e.kind, status: e.status };
      throw e;
    }
    return 'ok';
  };

  describe('Voice changer', () => {
    it('sends the recording as multipart with the model and no noise removal, to the chosen voice, and takes mp3 back', async () => {
      const out = await provider().changeVoice({
        file: file(wavFile(3), 'audio/wav'),
        voiceId: 'tunde',
        model: 'eleven_english_sts_v2',
      });
      expect(out.contentType).toBe('audio/mpeg');
      expect(out.audio.length).toBeGreaterThan(0);
      expect(standin.state.voiceChanges).toEqual([
        {
          voice: 'stand-in-tunde',
          model: 'eleven_english_sts_v2',
          bytes: wavFile(3).length,
          fileType: 'audio/wav',
          removeNoise: 'false',
        },
      ]);
    });

    it('streams a big recording without holding it and hands the read gate its place back', async () => {
      const wav = wavFile(2, 'x'.repeat(200_000));
      let sent = 0;
      const out = await provider().changeVoice({
        file: {
          bytes: wav.length,
          contentType: 'audio/wav',
          stream: Readable.from([wav], { objectMode: false }),
          sent: () => {
            sent += 1;
          },
        },
        voiceId: 'ada',
        model: 'eleven_english_sts_v2',
      });
      expect(out.audio.length).toBeGreaterThan(0);
      expect(sent).toBeGreaterThan(0);
      expect(standin.state.voiceChanges[0].bytes).toBe(wav.length);
    });

    it("takes the answer typed application/octet-stream (as the provider's file types it) but never a page or a body that is not MP3", async () => {
      const ok = await provider().changeVoice({
        file: file(wavFile(1, '[[octet]]'), 'audio/wav'),
        voiceId: 'ada',
        model: 'eleven_english_sts_v2',
      });
      expect(ok.audio.length).toBeGreaterThan(0);
      expect(
        await kind(
          provider().changeVoice({
            file: file(wavFile(1, '[[html]]'), 'audio/wav'),
            voiceId: 'ada',
            model: 'eleven_english_sts_v2',
          }),
        ),
      ).toEqual({ kind: 'unavailable', status: undefined });
    });

    it('says rejected for a refusal, unavailable for a fault, and carries the status for the log', async () => {
      const call = (marker: string) =>
        provider().changeVoice({
          file: file(wavFile(1, marker), 'audio/wav'),
          voiceId: 'ada',
          model: 'eleven_english_sts_v2',
        });
      expect(await kind(call('[[reject]]'))).toEqual({
        kind: 'rejected',
        status: 422,
      });
      expect(await kind(call('[[moderated]]'))).toEqual({
        kind: 'rejected',
        status: 422,
      });
      expect(await kind(call('[[fail]]'))).toEqual({
        kind: 'unavailable',
        status: 500,
      });
      expect(await kind(call('[[status:402]]'))).toEqual({
        kind: 'rejected',
        status: 402,
      });
    });

    it('refuses an unknown voice and a model name that is not a model name, before any call', async () => {
      const p = provider();
      expect(
        await kind(
          p.changeVoice({
            file: file(wavFile(1)),
            voiceId: 'nobody',
            model: 'eleven_english_sts_v2',
          }),
        ),
      ).toMatchObject({ kind: 'rejected' });
      expect(
        await kind(
          p.changeVoice({
            file: file(wavFile(1)),
            voiceId: 'ada',
            model: 'bad model!',
          }),
        ),
      ).toMatchObject({ kind: 'rejected' });
      expect(standin.state.voiceChanges).toHaveLength(0);
    });
  });

  describe('Dialogue', () => {
    it('sends the lines with their voices and the model as JSON and takes mp3 back', async () => {
      const out = await provider().makeDialogue({
        lines: [
          { text: 'Hello there.', voiceId: 'ada' },
          { text: 'Hi.', voiceId: 'tunde' },
          { text: 'Bye.', voiceId: 'ada' },
        ],
        model: 'eleven_v3',
      });
      expect(out.contentType).toBe('audio/mpeg');
      expect(standin.state.dialogues).toEqual([
        {
          model: 'eleven_v3',
          lines: 3,
          voices: ['stand-in-ada', 'stand-in-tunde'],
          chars: 'Hello there.Hi.Bye.'.length,
        },
      ]);
    });

    it("speaks a line in the person's saved clone by its provider id and refuses a line in a voice it does not know", async () => {
      // Make a clone on the stand-in, then use its provider id in a scene.
      const made = await provider().cloneVoice({
        name: 'wawu-voice',
        file: file(wavFile(12), 'audio/wav'),
      });
      const out = await provider().makeDialogue({
        lines: [
          {
            text: 'Mine.',
            voiceId: 'own',
            providerVoiceId: made.providerVoiceId,
          },
          { text: 'Yours.', voiceId: 'ada' },
        ],
        model: 'eleven_v3',
      });
      expect(out.audio.length).toBeGreaterThan(0);
      expect(standin.state.dialogues[0].voices).toContain(made.providerVoiceId);
      expect(await provider().deleteOwnVoice(made.providerVoiceId)).toBe(
        'deleted',
      );
      expect(
        await kind(
          provider().makeDialogue({
            lines: [{ text: 'x', voiceId: 'nobody' }],
            model: 'eleven_v3',
          }),
        ),
      ).toMatchObject({ kind: 'rejected' });
    });

    it('carries the stand-in refusals (fail, reject, more than 10 voices) as the provider would', async () => {
      const lines = (text: string) => [{ text, voiceId: 'ada' }];
      expect(
        await kind(
          provider().makeDialogue({
            lines: lines('[[fail]]'),
            model: 'eleven_v3',
          }),
        ),
      ).toMatchObject({ kind: 'unavailable' });
      expect(
        await kind(
          provider().makeDialogue({
            lines: lines('[[reject]]'),
            model: 'eleven_v3',
          }),
        ),
      ).toMatchObject({ kind: 'rejected' });
    });
  });

  describe('Clone your own voice', () => {
    it('adds the voice with a plain name, answers its id, and deletes it again', async () => {
      const p = provider(false);
      const made = await p.cloneVoice({
        name: 'wawu-voice',
        file: file(wavFile(12), 'audio/wav'),
      });
      expect(made.providerVoiceId).toMatch(/^clone-\d+$/);
      expect(standin.state.cloneNames.at(-1)).toBe('wawu-voice');
      expect(standin.openClones()).toBeGreaterThanOrEqual(1);
      const before = standin.openClones();
      expect(await p.deleteOwnVoice(made.providerVoiceId)).toBe('deleted');
      expect(standin.openClones()).toBe(before - 1);
      expect(await p.deleteOwnVoice(made.providerVoiceId)).toBe('not_found');
    });

    it('says rejected for a sample the provider refuses and for a plan with no voice slots left', async () => {
      const call = (m: string) =>
        provider(false).cloneVoice({
          name: 'wawu-voice',
          file: file(wavFile(12, m), 'audio/wav'),
        });
      expect(await kind(call('[[sample-reject]]'))).toMatchObject({
        kind: 'rejected',
      });
      expect(await kind(call('[[sample-slots]]'))).toMatchObject({
        kind: 'rejected',
        status: 400,
      });
      expect(await kind(call('[[sample-fail]]'))).toMatchObject({
        kind: 'unavailable',
      });
    });

    it('speaks and quick-speaks in a saved clone by its provider id, and not in a bad id', async () => {
      const p = provider();
      const made = await p.cloneVoice({
        name: 'wawu-voice',
        file: file(wavFile(12), 'audio/wav'),
      });
      await p.speak({
        voiceId: 'own',
        text: 'Hello',
        providerVoiceId: made.providerVoiceId,
      });
      await p.speakQuick({
        voiceId: 'own',
        text: 'Hello',
        providerVoiceId: made.providerVoiceId,
      });
      expect(standin.state.voices.slice(-2)).toEqual([
        made.providerVoiceId,
        made.providerVoiceId,
      ]);
      expect(
        await kind(
          p.speak({ voiceId: 'own', text: 'x', providerVoiceId: '../x' }),
        ),
      ).toMatchObject({ kind: 'rejected' });
      await p.deleteOwnVoice(made.providerVoiceId);
    });
  });

  describe('Music for a video', () => {
    it('sends the video as the field videos, the mood as description and no model, and takes music (mp3) back', async () => {
      const video = Buffer.concat([Buffer.alloc(64, 7), Buffer.from('video')]);
      const out = await provider(false).makeMusicForVideo({
        file: file(video, 'video/mp4'),
        description: 'warm and slow',
      });
      expect(out.contentType).toBe('audio/mpeg');
      expect(standin.state.videoMusic).toEqual([
        {
          bytes: video.length,
          fileType: 'video/mp4',
          descriptionChars: 'warm and slow'.length,
          model: null,
        },
      ]);
      await provider(false).makeMusicForVideo({
        file: file(video, 'video/mp4'),
        description: null,
      });
      expect(standin.state.videoMusic[1].descriptionChars).toBe(0);
    });

    it('carries a 403 (the plan does not cover the route) with its status, and the other refusals and faults', async () => {
      const call = (m: string) =>
        provider(false).makeMusicForVideo({
          file: file(Buffer.from(`video ${m}`), 'video/mp4'),
          description: null,
        });
      expect(await kind(call('[[plan]]'))).toEqual({
        kind: 'rejected',
        status: 403,
      });
      expect(await kind(call('[[reject]]'))).toMatchObject({
        kind: 'rejected',
      });
      expect(await kind(call('[[fail]]'))).toMatchObject({
        kind: 'unavailable',
      });
      expect(await kind(call('[[html]]'))).toMatchObject({
        kind: 'unavailable',
      });
    });
  });

  describe('Split a song', () => {
    it('asks for two or six stems and hands the ZIP back unopened', async () => {
      const two = await provider(false).splitStems({
        file: file(mp3File(3)),
        parts: 2,
      });
      const six = await provider(false).splitStems({
        file: file(mp3File(3)),
        parts: 6,
      });
      expect(standin.state.stems.map((s) => s.variation)).toEqual([
        'two_stems_v1',
        'six_stems_v1',
      ]);
      expect(readZip(two.archive).map((f) => f.name)).toEqual([
        'vocals.mp3',
        'instrumental.mp3',
      ]);
      expect(readZip(six.archive)).toHaveLength(6);
    });

    it('refuses and faults like the other routes, and carries a 403', async () => {
      const call = (m: string) =>
        provider(false).splitStems({
          file: file(mp3File(2, m)),
          parts: 2,
        });
      expect(await kind(call('[[plan]]'))).toEqual({
        kind: 'rejected',
        status: 403,
      });
      expect(await kind(call('[[reject]]'))).toMatchObject({
        kind: 'rejected',
      });
      expect(await kind(call('[[fail]]'))).toMatchObject({
        kind: 'unavailable',
      });
      expect(await kind(call('[[html]]'))).toMatchObject({
        kind: 'unavailable',
      });
    });
  });

  it('is off without a host and a key', async () => {
    const off = new HttpVoiceProvider(new ConfigService({}));
    expect(
      await kind(off.splitStems({ file: file(mp3File(1)), parts: 2 })),
    ).toMatchObject({ kind: 'rejected' });
    expect(
      await kind(
        off.cloneVoice({ name: 'x', file: file(wavFile(1), 'audio/wav') }),
      ),
    ).toMatchObject({ kind: 'rejected' });
  });
});
