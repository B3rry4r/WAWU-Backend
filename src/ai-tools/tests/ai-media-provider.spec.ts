import { ConfigService } from '@nestjs/config';
import {
  AiVoiceProviderError,
  VIDEO_MODEL_LENGTHS,
} from '../voice/ai-voice-provider';
import {
  HttpVoiceProvider,
  parseGenerationProgress,
  parseStartedGeneration,
  parseUploadedAsset,
} from '../voice/http-voice-provider';
import { startStandin } from '../../../test/ai-tools/voice-standin-for-specs';
import {
  assetCopyOf,
  assetIdsOf,
  copyOfFlow,
  endMarkerOfFlow,
  flowRef,
  parseFlowRef,
} from '../flow/flow-support';
import { endMarkerOf } from '../dub/dub-support';
import { sniffImage } from '../input/image-sniff';
import { IMAGE_TOOL } from '../tools/image.tool';
import { TALKING_PHOTO_TOOL } from '../tools/talking-photo.tool';
import { VIDEO_LENGTHS, VIDEO_TOOL } from '../tools/video.tool';

/**
 * The adapter's picture and video calls (AITOOLS-09, AITOOLS-10) against the
 * local stand-in with the provider's wire shape, the pure parts on their own,
 * and the guards on the signed links the provider names. NO real provider call:
 * the owner's credits are not bought yet.
 */
describe('AITOOLS-09, AITOOLS-10: the AI provider seam, pictures and video', () => {
  let standin: Awaited<ReturnType<typeof startStandin>>;
  beforeAll(async () => {
    standin = await startStandin('spec-key');
  });
  afterAll(async () => {
    await new Promise<void>((r) => standin.server.close(() => r()));
  });
  beforeEach(() => {
    const s = standin.state;
    s.assets.length = 0;
    s.deletedAssets.length = 0;
    s.images.length = 0;
    s.videos.length = 0;
    s.genReads.length = 0;
    s.genDownloads.length = 0;
    s.genKeyLeaks = 0;
  });
  const provider = (base = `http://127.0.0.1:${standin.port}`) =>
    new HttpVoiceProvider(
      new ConfigService({
        AI_VOICE_BASE_URL: base,
        AI_VOICE_API_KEY: 'spec-key',
      }),
    );
  const photo = (tail = '') => ({
    audio: Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      Buffer.from(tail || 'photo bytes'),
    ]),
    contentType: 'image/png',
  });
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('is on with a host and a key and no voice; the four tools follow it', () => {
    expect(provider().mediaToolsConfigured).toBe(true);
    for (const t of [IMAGE_TOOL, VIDEO_TOOL, TALKING_PHOTO_TOOL])
      expect(t.enabled(provider())).toBe(true);
    const off = new HttpVoiceProvider(
      new ConfigService({ AI_VOICE_API_KEY: 'k' }),
    );
    expect(off.mediaToolsConfigured).toBe(false);
    expect(IMAGE_TOOL.enabled(off)).toBe(false);
  });

  it('starts a picture with the model, shape and size and no photo, and reads it through pending, generating and completed', async () => {
    const p = provider();
    const started = await p.startImage({
      model: 'gemini-3.1-flash-image',
      prompt: 'a red circle [[slow:600]]',
      shape: '1:1',
      resolution: '1K',
      assetIds: [],
    });
    expect(started.id).toMatch(/^gen-/);
    expect(standin.state.images[0]).toMatchObject({
      model: 'gemini-3.1-flash-image',
      shape: '1:1',
      resolution: '1K',
      assetIds: [],
    });
    const seen = new Set<string>();
    for (let i = 0; i < 30 && !seen.has('completed'); i++) {
      const r = await p.readImage(started.id);
      seen.add(r.status);
      if (r.status === 'completed') {
        expect(r.contentType).toBe('image/png');
        expect(r.contentUrl).toMatch(/\/__standin\/gen-out\//);
      }
      await wait(60);
    }
    expect(seen.has('pending')).toBe(true);
    expect(seen.has('generating')).toBe(true);
    expect(seen.has('completed')).toBe(true);
  });

  it('uploads a photo as an asset, names it in the picture request, and deletes it (a second delete says it is already gone)', async () => {
    const p = provider();
    const up = await p.uploadAsset({ file: photo(), kind: 'photo' });
    expect(up.assetId).toMatch(/^asset-/);
    expect(standin.state.assets[0]).toMatchObject({
      type: 'image/png',
      name: 'photo.png',
    });
    await p.startImage({
      model: 'gemini-3.1-flash-image',
      prompt: 'make it black and white',
      shape: 'auto',
      resolution: '1K',
      assetIds: [up.assetId],
    });
    expect(standin.state.images[0].assetIds).toEqual([up.assetId]);
    expect(standin.openAssets()).toBe(1);
    expect(await p.removeAsset(up.assetId)).toBe('deleted');
    expect(standin.openAssets()).toBe(0);
    expect(await p.removeAsset(up.assetId)).toBe('not_found');
    // An id that is not an id is never put in a path.
    expect(await p.removeAsset('../x')).toBe('failed');
  });

  it('refuses a photo type the Hub does not name, before anything is sent', async () => {
    await expect(
      provider().uploadAsset({
        file: { audio: Buffer.from('x'), contentType: 'image/gif' },
        kind: 'photo',
      }),
    ).rejects.toMatchObject({ kind: 'rejected' });
    expect(standin.state.assets).toHaveLength(0);
  });

  it('sends a clip with the length as a number, the shape, the sound and the first frame; and a talking photo with its photo and voice and no words', async () => {
    const p = provider();
    const frame = await p.uploadAsset({ file: photo(), kind: 'photo' });
    await p.startVideo({
      kind: 'clip',
      model: 'veo-3.1-fast-generate-001',
      prompt: 'a red ball rolls across a table',
      shape: '16:9',
      seconds: 4,
      resolution: '720p',
      withSound: false,
      startFrameAssetId: frame.assetId,
    });
    expect(standin.state.videos[0]).toMatchObject({
      kind: 'clip',
      model: 'veo-3.1-fast-generate-001',
      seconds: 4,
      shape: '16:9',
      resolution: '720p',
      withSound: false,
      assetIds: [frame.assetId],
    });
    const speech = await p.uploadAsset({
      file: { audio: Buffer.from('RIFFspeech'), contentType: 'audio/wav' },
      kind: 'speech',
    });
    expect(standin.state.assets[1]).toMatchObject({ name: 'speech.wav' });
    await p.startVideo({
      kind: 'talking',
      model: 'creatify-aurora',
      resolution: '480p',
      imageAssetId: frame.assetId,
      audioAssetId: speech.assetId,
    });
    expect(standin.state.videos[1]).toMatchObject({
      kind: 'talking',
      model: 'creatify-aurora',
      resolution: '480p',
      assetIds: [frame.assetId, speech.assetId],
    });
    expect(standin.state.videos[1]).not.toHaveProperty('promptChars');
  });

  it('VIDEO-DUR: every clip model gets duration_secs as a NUMBER on the wire (the live provider refuses the string), and a length the model does not make never leaves the Hub', async () => {
    const real = globalThis.fetch;
    const wire: Record<string, unknown>[] = [];
    const spy = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation((url, init) => {
        wire.push(JSON.parse(init?.body as string) as Record<string, unknown>);
        return real(url, init);
      });
    try {
      const p = provider();
      const clip = (model: string, seconds: number) =>
        p.startVideo({
          kind: 'clip',
          model,
          prompt: 'a red ball rolls',
          shape: '16:9',
          seconds,
          resolution: '720p',
          withSound: false,
          startFrameAssetId: null,
        });
      for (const [model, lengths] of Object.entries(VIDEO_MODEL_LENGTHS)) {
        // Every length the Hub offers, and the longest the model makes.
        for (const seconds of new Set([...VIDEO_LENGTHS, lengths.at(-1)!])) {
          wire.length = 0;
          await clip(model, seconds);
          expect([model, typeof wire[0].duration_secs]).toEqual([
            model,
            'number',
          ]);
          expect(wire[0]).toMatchObject({
            model_id: model,
            duration_secs: seconds,
          });
        }
        // One second past the longest, and one short of the shortest: refused before anything is sent.
        wire.length = 0;
        for (const seconds of [lengths[0] - 1, lengths.at(-1)! + 1])
          await expect(clip(model, seconds)).rejects.toMatchObject({
            kind: 'rejected',
          });
        expect(wire).toHaveLength(0);
      }
      // Veo makes 4, 6 and 8 and nothing between.
      for (const seconds of [5, 7])
        await expect(
          clip('veo-3.1-fast-generate-001', seconds),
        ).rejects.toMatchObject({ kind: 'rejected' });
      expect(wire).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
    // The stand-in answers as the live provider did: a string length is a 422.
    const raw = await fetch(`http://127.0.0.1:${standin.port}/v1/flows/video`, {
      method: 'POST',
      headers: { 'xi-api-key': 'spec-key', 'content-type': 'application/json' },
      body: JSON.stringify({
        model_id: 'veo-3.1-fast-generate-001',
        prompt: 'x',
        duration_secs: '4',
      }),
    });
    expect(raw.status).toBe(422);
  });

  it('a refused start is rejected (trying again will not help), a start the provider fails is unavailable, and the words never reach the error', async () => {
    const p = provider();
    const base = {
      model: 'gemini-3.1-flash-image',
      shape: '1:1',
      resolution: '1K',
      assetIds: [] as string[],
    };
    const refused = await p
      .startImage({ ...base, prompt: 'secret words [[reject]]' })
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(AiVoiceProviderError);
    expect((refused as AiVoiceProviderError).kind).toBe('rejected');
    expect((refused as AiVoiceProviderError).status).toBe(422);
    expect((refused as Error).message).not.toContain('secret');
    const down = await p
      .startImage({ ...base, prompt: 'x [[start-fail]]' })
      .catch((e: unknown) => e);
    expect((down as AiVoiceProviderError).kind).toBe('unavailable');
    const plan = await p
      .startImage({ ...base, prompt: 'x [[status:402]]' })
      .catch((e: unknown) => e);
    expect((plan as AiVoiceProviderError).status).toBe(402);
    // A model name that is not a plain name never leaves the Hub.
    await expect(
      p.startImage({ ...base, prompt: 'x', model: 'a b; DROP' }),
    ).rejects.toMatchObject({ kind: 'rejected' });
    await expect(
      p.startImage({ ...base, prompt: 'x', assetIds: ['../x'] }),
    ).rejects.toMatchObject({ kind: 'rejected' });
  });

  it('reads the failure reasons of a generation: moderated, a model fault, and a request the provider refused', async () => {
    const p = provider();
    const base = {
      model: 'gemini-3.1-flash-image',
      shape: '1:1',
      resolution: '1K',
      assetIds: [] as string[],
    };
    const moderated = await p.startImage({
      ...base,
      prompt: 'a [[moderated]]',
    });
    expect(await p.readImage(moderated.id)).toMatchObject({
      status: 'failed',
      failure: 'moderated',
    });
    const fault = await p.startImage({ ...base, prompt: 'a [[fail]]' });
    expect(await p.readImage(fault.id)).toMatchObject({
      status: 'failed',
      failure: 'model_error',
    });
    const invalid = await p.startImage({ ...base, prompt: 'a [[invalid]]' });
    expect(await p.readImage(invalid.id)).toMatchObject({
      status: 'failed',
      failure: 'invalid_parameters',
    });
    // A generation the provider does not know is a 404 the follower acts on.
    await expect(p.readImage('gen-9999')).rejects.toMatchObject({
      status: 404,
    });
    // A picture id read as a video is not found either.
    await expect(p.readVideo(moderated.id)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('opens a finished file once as a stream of exactly its bytes, with no key sent and no memory held', async () => {
    const p = provider();
    const started = await p.startImage({
      model: 'gemini-3.1-flash-image',
      prompt: 'a [[bytes:300000]]',
      shape: '1:1',
      resolution: '1K',
      assetIds: [],
    });
    const done = await p.readImage(started.id);
    const media = await p.openGeneration(done.contentUrl!, {
      maxBytes: 1_000_000,
      types: ['image/png', 'image/jpeg', 'image/webp'],
    });
    expect(media.contentType).toBe('image/png');
    expect(media.bytes).toBe(300000);
    let n = 0;
    for await (const c of media.stream) n += (c as Buffer).length;
    expect(n).toBe(300000);
    media.close();
    expect(standin.state.genDownloads).toEqual([
      { id: started.id, status: 200, leaked: false },
    ]);
    expect(standin.state.genKeyLeaks).toBe(0);
  });

  it('refuses a file in a type the Hub does not serve, one over the cap, one that fails, a link that is not a link, and a link to another host', async () => {
    const p = provider();
    const make = async (prompt: string) => {
      const s = await p.startImage({
        model: 'gemini-3.1-flash-image',
        prompt,
        shape: '1:1',
        resolution: '1K',
        assetIds: [],
      });
      return (await p.readImage(s.id)).contentUrl!;
    };
    const types = ['image/png', 'image/jpeg', 'image/webp'];
    await expect(
      p.openGeneration(await make('a [[type:image/gif]]'), {
        maxBytes: 1e6,
        types,
      }),
    ).rejects.toMatchObject({ kind: 'unavailable' });
    await expect(
      p.openGeneration(await make('a [[bytes:5000]]'), {
        maxBytes: 4000,
        types,
      }),
    ).rejects.toMatchObject({ kind: 'unavailable' });
    await expect(
      p.openGeneration(await make('a [[outfail]]'), { maxBytes: 1e6, types }),
    ).rejects.toMatchObject({ status: 500 });
    for (const bad of [
      'not a link',
      'file:///etc/passwd',
      'ftp://example.com/x',
      'https://user:pw@example.com/x',
      'https://127.0.0.1/x',
      'http://example.com/x',
    ])
      await expect(
        p.openGeneration(bad, { maxBytes: 1e6, types }),
      ).rejects.toMatchObject({ kind: 'unavailable' });
    expect(standin.state.genKeyLeaks).toBe(0);
  });

  it('a stream longer than its cap stops, and the stream can be given back', async () => {
    const p = provider();
    const s = await p.startImage({
      model: 'gemini-3.1-flash-image',
      prompt: 'a [[bytes:200000]]',
      shape: '1:1',
      resolution: '1K',
      assetIds: [],
    });
    const link = (await p.readImage(s.id)).contentUrl!;
    // The provider does not declare a length here: the cap is enforced on the stream itself.
    const media = await p.openGeneration(link, {
      maxBytes: 200000,
      types: ['image/png'],
    });
    media.close();
    media.close();
    expect(media.stream.destroyed).toBe(true);
  });
});

describe('the pure parts of the picture and video seam', () => {
  it('reads an asset, a started generation and a progress answer, and refuses an answer that is not one', () => {
    expect(parseUploadedAsset(Buffer.from('{"asset_id":"a1"}'))).toEqual({
      assetId: 'a1',
    });
    expect(() =>
      parseUploadedAsset(Buffer.from('{"asset_id":"../x"}')),
    ).toThrow(AiVoiceProviderError);
    expect(() => parseUploadedAsset(Buffer.from('not json'))).toThrow(
      AiVoiceProviderError,
    );
    expect(
      parseStartedGeneration(Buffer.from('{"id":"g1","status":"pending"}')),
    ).toEqual({ id: 'g1' });
    expect(() => parseStartedGeneration(Buffer.from('{}'))).toThrow(
      AiVoiceProviderError,
    );
    expect(
      parseGenerationProgress(
        Buffer.from(
          '{"status":"completed","id":"g","content_url":"https://x.test/f","content_mime_type":"Image/PNG; q=1"}',
        ),
      ),
    ).toEqual({
      status: 'completed',
      contentUrl: 'https://x.test/f',
      contentType: 'image/png',
      failure: null,
    });
    // A completed answer with no link is not a result: read again later.
    expect(() =>
      parseGenerationProgress(Buffer.from('{"status":"completed","id":"g"}')),
    ).toThrow(AiVoiceProviderError);
    expect(() =>
      parseGenerationProgress(Buffer.from('{"status":"melting","id":"g"}')),
    ).toThrow(AiVoiceProviderError);
    expect(
      parseGenerationProgress(
        Buffer.from('{"status":"failed","id":"g","failure_reason":"nonsense"}'),
      ).failure,
    ).toBe('unknown');
    expect(
      parseGenerationProgress(Buffer.from('{"status":"generating","id":"g"}')),
    ).toEqual({
      status: 'generating',
      contentUrl: null,
      contentType: null,
      failure: null,
    });
  });

  it('keeps a followed run on the job row and finds the assets again, also after a restart', () => {
    const ref = flowRef('video', 'gen-1', ['asset-1', 'asset-2']);
    expect(ref).toBe('genrun:video:gen-1:asset-1+asset-2');
    expect(parseFlowRef(ref)).toEqual({
      kind: 'video',
      generationId: 'gen-1',
      assetIds: ['asset-1', 'asset-2'],
    });
    expect(parseFlowRef(flowRef('image', 'gen-2', []))).toEqual({
      kind: 'image',
      generationId: 'gen-2',
      assetIds: [],
    });
    expect(copyOfFlow(parseFlowRef(ref)!)).toEqual({
      kind: 'asset',
      id: 'asset-1+asset-2',
    });
    expect(copyOfFlow(parseFlowRef('genrun:image:gen-2')!)).toBeNull();
    expect(assetIdsOf({ kind: 'asset', id: 'a+b' })).toEqual(['a', 'b']);
    expect(assetCopyOf([])).toBeNull();
    // What a row takes when the run ends: the assets still to delete.
    expect(endMarkerOf(ref)).toBe('asset:asset-1+asset-2');
    expect(endMarkerOfFlow('genrun:image:gen-2')).toBeUndefined();
    expect(endMarkerOf('dubrun:p1:l1')).toBe('dub:p1');
    for (const bad of [
      null,
      '',
      'genrun:',
      'genrun:audio:g',
      'genrun:image:',
      'genrun:image:g:a:b',
      'genrun:image:../x',
      'genrun:image:g:../x',
      'genrun:image:g:a+b+c+d+e',
      'dubrun:p:l',
    ])
      expect([bad, parseFlowRef(bad)]).toEqual([bad, null]);
  });

  it('knows a PNG, a JPEG and a WebP picture by its first bytes, and nothing else', () => {
    const png = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
    png.writeUInt32BE(13, 8);
    png.write('IHDR', 12, 'latin1');
    png.writeUInt32BE(640, 16);
    png.writeUInt32BE(480, 20);
    expect(sniffImage(png)).toEqual({
      contentType: 'image/png',
      width: 640,
      height: 480,
    });
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xc0, 0x00, 0x0b,
      0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0, 0, 0,
    ]);
    expect(sniffImage(jpeg)).toEqual({
      contentType: 'image/jpeg',
      width: 640,
      height: 480,
    });
    const webp = Buffer.alloc(30);
    webp.write('RIFF', 0, 'latin1');
    webp.write('WEBP', 8, 'latin1');
    webp.write('VP8X', 12, 'latin1');
    webp.writeUIntLE(639, 24, 3);
    webp.writeUIntLE(479, 27, 3);
    expect(sniffImage(webp)).toEqual({
      contentType: 'image/webp',
      width: 640,
      height: 480,
    });
    expect(sniffImage(Buffer.from('GIF89a......................'))).toBeNull();
    expect(
      sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')),
    ).toBeNull();
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
    // A PNG signature with no real header, and a picture with no size, are not pictures.
    expect(sniffImage(png.subarray(0, 12))).toBeNull();
    png.writeUInt32BE(0, 16);
    expect(sniffImage(png)).toBeNull();
  });
});
