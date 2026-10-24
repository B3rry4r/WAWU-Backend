import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ConfigService } from '@nestjs/config';
import { AiVoiceProviderError } from '../voice/ai-voice-provider';
import {
  HttpVoiceProvider,
  parseDubProgress,
  parseStartedDub,
} from '../voice/http-voice-provider';
import { startStandin } from '../../../test/ai-tools/voice-standin-for-specs';
import { wavFile } from '../../../test/ai-tools/media-fixtures';
import { DUBBING_TOOL } from '../tools/dubbing.tool';
import {
  dubLanguagesOf,
  endMarkerOf,
  findDubLanguage,
  followRef,
  parseFollowRef,
} from '../dub/dub-support';
import { audioCapFor } from '../dub/ai-dub.service';

/**
 * The adapter's dubbing calls (AITOOLS-05) against the local stand-in with the
 * provider's wire shape, the pure parts on their own, and the guards on the
 * signed links the provider names. NOT RUN against the real provider.
 */
describe('AITOOLS-05: the AI provider seam, Dubbing', () => {
  let standin: Awaited<ReturnType<typeof startStandin>>;
  beforeAll(async () => {
    standin = await startStandin('spec-key');
  });
  afterAll(async () => {
    await new Promise<void>((r) => standin.server.close(() => r()));
  });
  beforeEach(() => {
    const s = standin.state;
    s.dubs.length = 0;
    s.dubReads.length = 0;
    s.dubDownloads.length = 0;
    s.dubKeyLeaks = 0;
    s.deletedDubs.length = 0;
  });
  const provider = (base = `http://127.0.0.1:${standin.port}`) =>
    new HttpVoiceProvider(
      new ConfigService({
        AI_VOICE_BASE_URL: base,
        AI_VOICE_API_KEY: 'spec-key',
      }),
    );
  const audio = (seconds: number, tail = '') => ({
    audio: wavFile(seconds, tail),
    contentType: 'audio/wav',
  });

  it('is on with a host and a key and no voice, like the other file tools', () => {
    expect(provider().fileToolsConfigured).toBe(true);
    expect(DUBBING_TOOL.enabled(provider())).toBe(true);
    expect(
      DUBBING_TOOL.enabled(
        new HttpVoiceProvider(new ConfigService({ AI_VOICE_API_KEY: 'k' })),
      ),
    ).toBe(false);
  });

  it('starts a dub with the file, the target and the source language and no model, and reads it through to completed', async () => {
    const p = provider();
    const started = await p.startDub({
      file: audio(30, '[[dub-delay:300]]'),
      targetLanguage: 'yo',
      sourceLanguage: 'en',
    });
    expect(started.languageId).toMatch(/^lang-/);
    expect(standin.state.dubs[0]).toMatchObject({
      target: 'yo',
      source: 'en',
      model: null,
      fileType: 'audio/wav',
    });
    const first = await p.readDub(started.projectId, started.languageId!);
    expect(['queued', 'processing']).toContain(first.status);
    expect(first.audioUrl).toBeNull();
    await new Promise((r) => setTimeout(r, 350));
    const done = await p.readDub(started.projectId, started.languageId!);
    expect(done.status).toBe('completed');
    expect(done.audioUrl).toContain('/__standin/dub-out/');
    const out = await p.fetchDubOutputs(
      { audioUrl: done.audioUrl!, subtitlesUrl: done.subtitlesUrl },
      { maxAudioBytes: 10_000_000 },
    );
    expect(out.audio.toString('latin1', 0, 4)).toBe('fLaC');
    expect(out.contentType).toBe('audio/flac');
    expect(out.subtitles).toMatch(/^WEBVTT/);
    expect(standin.state.dubKeyLeaks).toBe(0); // the key never goes to a link
    expect(await p.dubPresence(started.projectId)).toBe('present');
    expect(await p.removeDub(started.projectId)).toBe('deleted');
    expect(await p.dubPresence(started.projectId)).toBe('absent');
    expect(await p.removeDub(started.projectId)).toBe('not_found');
    await expect(
      p.readDub(started.projectId, started.languageId!),
    ).rejects.toMatchObject({ status: 404, kind: 'rejected' });
  });

  it('turns a refused or unreadable start into the seam error, with the status for the log', async () => {
    const p = provider();
    const go = (marks: string) =>
      p.startDub({
        file: audio(5, marks),
        targetLanguage: 'yo',
        sourceLanguage: null,
      });
    await expect(go('[[status:402]]')).rejects.toMatchObject({
      kind: 'rejected',
      status: 402,
    });
    await expect(go('[[fail]]')).rejects.toMatchObject({
      kind: 'unavailable',
      status: 500,
    });
    await expect(go('[[html]]')).rejects.toBeInstanceOf(AiVoiceProviderError);
    // A tag that is not a tag never reaches the multipart body.
    await expect(
      p.startDub({
        file: audio(5),
        targetLanguage: 'yo"\r\nx: y',
        sourceLanguage: null,
      }),
    ).rejects.toMatchObject({ kind: 'rejected' });
    expect(standin.state.dubs).toHaveLength(3); // the three above reached it; the bad tag did not
    // A project without a language comes back with a null language, so it can be deleted.
    const nolang = await p.startDub({
      file: audio(5, '[[dub-nolang]]'),
      targetLanguage: 'yo',
      sourceLanguage: null,
    });
    expect(nolang.languageId).toBeNull();
    expect(await p.removeDub(nolang.projectId)).toBe('deleted');
  });

  it('reads the answers the provider documents, and nothing it does not', () => {
    const j = (o: unknown) => Buffer.from(JSON.stringify(o));
    expect(
      parseStartedDub(j({ project_id: 'p1', language_ids: ['l1'] })),
    ).toEqual({
      projectId: 'p1',
      languageId: 'l1',
    });
    expect(
      parseStartedDub(j({ project_id: 'p1', language_ids: [] })).languageId,
    ).toBeNull();
    for (const bad of [{}, { project_id: 5 }, { project_id: 'a/b' }])
      expect(() => parseStartedDub(j(bad))).toThrow(AiVoiceProviderError);
    expect(() => parseStartedDub(Buffer.from('<html>'))).toThrow(
      AiVoiceProviderError,
    );
    expect(
      parseDubProgress(
        j({
          status: 'completed',
          outputs: { lossless_audio: 'https://x/a', subtitles: null },
        }),
      ),
    ).toEqual({
      status: 'completed',
      audioUrl: 'https://x/a',
      subtitlesUrl: null,
    });
    expect(
      parseDubProgress(j({ status: 'processing', outputs: null })).audioUrl,
    ).toBeNull();
    expect(() => parseDubProgress(j({ status: 'invented' }))).toThrow(
      AiVoiceProviderError,
    );
  });

  describe('the signed links the provider names are not trusted', () => {
    let evil: Server;
    let port: number;
    let seen: { url: string; key: string | undefined }[] = [];
    const bodies = new Map<
      string,
      { status?: number; headers?: Record<string, string>; body: Buffer }
    >();
    beforeAll(async () => {
      evil = createServer((req, res) => {
        seen.push({
          url: req.url ?? '',
          key: req.headers['xi-api-key'] as string | undefined,
        });
        const b = bodies.get(req.url ?? '');
        res.statusCode = b?.status ?? 404;
        for (const [k, v] of Object.entries(b?.headers ?? {}))
          res.setHeader(k, v);
        res.end(b?.body);
      });
      await new Promise<void>((r) => evil.listen(0, '127.0.0.1', () => r()));
      port = (evil.address() as AddressInfo).port;
    });
    afterAll(async () => {
      await new Promise<void>((r) => evil.close(() => r()));
    });
    beforeEach(() => {
      seen = [];
      bodies.clear();
    });
    const flac = Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(100)]);

    it("refuses a host that is not the provider's own and not a name over https, without a request", async () => {
      const p = provider(); // base: the stand-in, not `evil`
      for (const link of [
        `http://127.0.0.1:${port}/a`, // another host over plain http
        'https://127.0.0.1/a',
        'https://[::1]/a',
        'https://localhost/a',
        'https://user:pw@files.example.test/a',
        'ftp://files.example.test/a',
        'not a link',
      ])
        await expect(
          p.fetchDubOutputs(
            { audioUrl: link, subtitlesUrl: null },
            { maxAudioBytes: 1000 },
          ),
        ).rejects.toMatchObject({ message: 'bad link' });
      expect(seen).toHaveLength(0);
    });

    it("fetches from the provider's own host with no key, refuses a redirect, a file that is not FLAC and one over the cap, and drops subtitles that are not WebVTT", async () => {
      const p = provider(`http://127.0.0.1:${port}`);
      bodies.set('/ok', { status: 200, body: flac });
      bodies.set('/vtt', {
        status: 200,
        body: Buffer.from('﻿WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhi\n'),
      });
      bodies.set('/bad', { status: 200, body: Buffer.from('<html>no</html>') });
      bodies.set('/nope', { status: 200, body: Buffer.alloc(100, 7) });
      bodies.set('/big', {
        status: 200,
        body: Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(5000)]),
      });
      bodies.set('/jump', {
        status: 302,
        headers: { location: '/ok' },
        body: Buffer.alloc(0),
      });
      const at = (path: string) => `http://127.0.0.1:${port}${path}`;
      const out = await p.fetchDubOutputs(
        { audioUrl: at('/ok'), subtitlesUrl: at('/vtt') },
        { maxAudioBytes: 1000 },
      );
      expect(out.subtitles).toMatch(/^WEBVTT/);
      expect(seen.every((s) => s.key === undefined)).toBe(true);
      expect(
        (
          await p.fetchDubOutputs(
            { audioUrl: at('/ok'), subtitlesUrl: at('/bad') },
            { maxAudioBytes: 1000 },
          )
        ).subtitles,
      ).toBeNull();
      expect(
        (
          await p.fetchDubOutputs(
            { audioUrl: at('/ok'), subtitlesUrl: at('/missing') },
            { maxAudioBytes: 1000 },
          )
        ).subtitles,
      ).toBeNull();
      for (const path of ['/nope', '/big', '/jump', '/missing'])
        await expect(
          p.fetchDubOutputs(
            { audioUrl: at(path), subtitlesUrl: null },
            { maxAudioBytes: 1000 },
          ),
        ).rejects.toBeInstanceOf(AiVoiceProviderError);
    });
  });

  it("keeps a followed job's ids on the row in one form and reads them back, and cleans a list of languages", () => {
    expect(followRef('p1', 'l1')).toBe('dubrun:p1:l1');
    expect(parseFollowRef('dubrun:p1:l1')).toEqual({
      projectId: 'p1',
      languageId: 'l1',
    });
    for (const bad of [
      null,
      '',
      'dub:p1',
      'dubrun:p1',
      'dubrun:p1:l1:x',
      'dubrun:a b:l1',
      'transcript:t1',
    ])
      expect(parseFollowRef(bad)).toBeNull();
    expect(endMarkerOf('dubrun:p1:l1')).toBe('dub:p1');
    expect(endMarkerOf('transcript:t1')).toBeUndefined();
    const list = dubLanguagesOf([
      'yo Yoruba',
      'pt-BR Portuguese (Brazil)',
      'x line',
      ' ha Hausa ',
    ]);
    expect(list).toEqual([
      { code: 'yo', name: 'Yoruba' },
      { code: 'pt-BR', name: 'Portuguese (Brazil)' },
      { code: 'ha', name: 'Hausa' },
    ]);
    expect(findDubLanguage(list, 'PT-br')?.code).toBe('pt-BR');
    expect(findDubLanguage(list, 'xx')).toBeNull();
  });

  it('bounds the dubbed audio the Hub will fetch by the minutes it priced', () => {
    expect(audioCapFor(1)).toBe(32 * 1024 * 1024);
    expect(audioCapFor(10)).toBe(200 * 1024 * 1024);
    expect(audioCapFor(1000)).toBe(400 * 1024 * 1024);
    expect(audioCapFor(0)).toBe(32 * 1024 * 1024);
  });
});
