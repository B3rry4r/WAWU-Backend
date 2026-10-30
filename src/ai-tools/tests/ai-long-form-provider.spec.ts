import { createServer, type Server } from 'node:http';
import { ConfigService } from '@nestjs/config';
import { AiVoiceProviderError } from '../voice/ai-voice-provider';
import { HttpVoiceProvider } from '../voice/http-voice-provider';
import { startStandin } from '../../../test/ai-tools/voice-standin-for-specs';
import { copyOfCast, endMarkerOfCast } from '../podcast/podcast-support';
import { endMarkerOf } from '../dub/dub-support';
import { copyOfMarker } from '../voice/provider-copy.service';
import { podcastLinkOk } from '../tools/podcast.tool';
import { conversationOf } from '../receptionist/receptionist.service';

/**
 * The adapter's Audiobook, Podcast maker and Receptionist calls (AITOOLS-13, AITOOLS-06) against the local stand-in with
 * the provider's wire shape, and the guards on the signed link the provider names. NO real provider call: the owner's
 * credits are not bought yet.
 */
describe('AITOOLS-13, AITOOLS-06: the AI provider seam, chapters, podcasts and agents', () => {
  let standin: Awaited<ReturnType<typeof startStandin>>;
  const VOICES = JSON.stringify([
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
  ]);
  beforeAll(async () => {
    standin = await startStandin('spec-key');
  });
  afterAll(async () => {
    await new Promise<void>((r) => standin.server.close(() => r()));
  });
  const provider = (
    base = `http://127.0.0.1:${standin.port}`,
    key = 'spec-key',
  ) =>
    new HttpVoiceProvider(
      new ConfigService({
        AI_VOICE_BASE_URL: base,
        AI_VOICE_API_KEY: key,
        AI_VOICE_VOICES: VOICES,
      }),
    );
  const spec = (over: Record<string, unknown> = {}) => ({
    name: 'Ada Braids',
    prompt: 'You are the receptionist. Never invent prices.',
    firstMessage: 'Hello.',
    language: 'en',
    llm: 'gemini-2.5-flash-lite',
    voiceId: 'ada',
    knowledge: [],
    ...over,
  });

  it('speaks a chapter on the speech route with the words around it and the model asked, and refuses an unknown voice', async () => {
    standin.state.speechContext.length = 0;
    const audio = await provider().speakChapter({
      voiceId: 'ada',
      text: 'Once upon a time.',
      model: 'eleven_multilingual_v2',
      previousText: 'Before.',
      nextText: null,
    });
    expect(audio.contentType).toBe('audio/mpeg');
    expect(standin.state.speechContext.at(-1)).toEqual({
      chars: 17,
      previous: 7,
      next: null,
    });
    expect(standin.state.models.at(-1)).toBe('eleven_multilingual_v2');
    await expect(
      provider().speakChapter({
        voiceId: 'nobody',
        text: 'x',
        model: 'eleven_multilingual_v2',
        previousText: null,
        nextText: null,
      }),
    ).rejects.toMatchObject({ kind: 'rejected' });
    await expect(
      provider().speakChapter({
        voiceId: 'ada',
        text: 'x',
        model: 'Bad Model!',
        previousText: null,
        nextText: null,
      }),
    ).rejects.toMatchObject({ kind: 'rejected' });
  });

  it("starts, reads, fetches and deletes a podcast project with the provider's body, and a 403 rides on the error", async () => {
    const p = provider();
    const started = await p.startPodcast({
      model: 'eleven_multilingual_v2',
      mode: 'conversation',
      hostVoiceId: 'ada',
      guestVoiceId: 'tunde',
      source: { type: 'text', text: 'A short text for a podcast.' },
      duration: 'default',
      language: 'en',
    });
    expect(standin.state.podcasts.at(-1)).toMatchObject({
      id: started.projectId,
      mode: 'conversation',
      host: 'stand-in-ada',
      guest: 'stand-in-tunde',
      duration: 'default',
      quality: 'standard',
    });
    expect((await p.readPodcast(started.projectId)).ready).toBe(true);
    const audio = await p.fetchPodcastAudio(started.projectId);
    expect(audio.audio.length).toBeGreaterThan(0);
    expect(await p.removePodcast(started.projectId)).toBe('deleted');
    expect(await p.removePodcast(started.projectId)).toBe('not_found');
    await expect(
      p.startPodcast({
        model: 'eleven_multilingual_v2',
        mode: 'bulletin',
        hostVoiceId: 'ada',
        guestVoiceId: null,
        source: { type: 'url', url: 'https://example.com/[[allowlist]]' },
        duration: 'short',
        language: 'en',
      }),
    ).rejects.toMatchObject({ kind: 'rejected', status: 403 });
    await expect(p.readPodcast('../x')).rejects.toBeInstanceOf(
      AiVoiceProviderError,
    );
    expect(await p.removePodcast('../x')).toBe('failed');
  });

  it('makes an agent with the knowledge listed, the text-only override on and the cheap model, edits it, and deletes it', async () => {
    const p = provider();
    const doc = await p.addKnowledgeText({
      name: 'Prices',
      text: 'Braids cost 25,000.',
    });
    const made = await p.createAgent(
      spec({ knowledge: [{ id: doc.id, name: 'Prices', kind: 'text' }] }),
    );
    expect(standin.agent(made.agentId)).toMatchObject({ knowledge: [doc.id] });
    expect(standin.state.agents.at(-1)).toMatchObject({
      llm: 'gemini-2.5-flash-lite',
      textOnlyOverride: true,
      voice: 'stand-in-ada',
    });
    await p.updateAgent(made.agentId, spec({ language: 'fr', knowledge: [] }));
    expect(standin.agent(made.agentId)).toMatchObject({
      knowledge: [],
      language: 'fr',
    });
    expect(await p.deleteKnowledge(doc.id)).toBe('deleted');
    expect(await p.deleteAgent(made.agentId)).toBe('deleted');
    expect(await p.deleteAgent(made.agentId)).toBe('not_found');
    await expect(
      p.createAgent(spec({ language: 'english' })),
    ).rejects.toMatchObject({ kind: 'rejected' });
    await expect(
      p.createAgent(spec({ voiceId: 'nobody' })),
    ).rejects.toMatchObject({ kind: 'rejected' });
    await expect(
      p.addKnowledgeUrl({ name: 'Page', url: 'http://example.com' }),
    ).rejects.toBeInstanceOf(AiVoiceProviderError);
  });

  it("asks an agent over the socket text-only without sending the key, and reads a conversation's length", async () => {
    const p = provider();
    const made = await p.createAgent(spec());
    const out = await p.askAgent({
      agentId: made.agentId,
      message: 'Hello',
      earlier: [
        { role: 'person', text: 'Hi' },
        { role: 'agent', text: 'Hello.' },
      ],
    });
    expect(out.reply).toMatch(/I know 0 things/);
    expect(standin.state.chats.at(-1)).toMatchObject({
      textOnly: true,
      earlier: true,
      keyLeak: false,
    });
    const link = await p.openVoiceSession(made.agentId);
    expect(link.conversationId).toMatch(/^convo-/);
    expect(await p.readConversation(link.conversationId)).toEqual({
      status: 'in-progress',
      seconds: 0,
    });
    standin.setConversation(link.conversationId, {
      status: 'done',
      seconds: 61,
    });
    expect(await p.readConversation(link.conversationId)).toEqual({
      status: 'done',
      seconds: 61,
    });
    expect(await p.deleteConversation(link.conversationId)).toBe('deleted');
    await p.deleteAgent(made.agentId);
  });

  it("refuses a signed link that is not a secure link to a name, or is not the provider's own host, and never connects to it", async () => {
    let link = '';
    const odd: Server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ signed_url: link }));
    });
    await new Promise<void>((r) => odd.listen(0, '127.0.0.1', r));
    try {
      const port = (odd.address() as { port: number }).port;
      const p = provider(`http://127.0.0.1:${port}`);
      for (const bad of [
        'ws://evil.example.com/agent?agent_id=a1',
        'wss://127.0.0.1/agent',
        'wss://localhost/agent',
        'wss://user:pw@evil.example.com/agent',
        'https://evil.example.com/agent',
        'not a link',
      ]) {
        link = bad;
        await expect(
          p.askAgent({ agentId: 'a1', message: 'Hi', earlier: [] }),
        ).rejects.toMatchObject({ message: 'bad link' });
      }
    } finally {
      await new Promise<void>((r) => odd.close(() => r()));
    }
  });

  it("refuses a socket link to another host, one that only looks like the provider's, and a host ending in a dot, and never connects to it", async () => {
    // Through the whole call: the provider's own answer names a stranger's host, so the Hub refuses it and never dials.
    let link = '';
    const odd: Server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ signed_url: link }));
    });
    await new Promise<void>((r) => odd.listen(0, '127.0.0.1', r));
    try {
      const port = (odd.address() as { port: number }).port;
      const p = provider(`http://127.0.0.1:${port}`);
      for (const bad of [
        'wss://evil.example.com/agent?agent_id=a1',
        'wss://api.provider.example.evil.example/agent?agent_id=a1',
        'wss://localhost./agent?agent_id=a1',
      ]) {
        link = bad;
        await expect(
          p.askAgent({ agentId: 'a1', message: 'Hi', earlier: [] }),
        ).rejects.toMatchObject({ message: 'bad link' });
      }
    } finally {
      await new Promise<void>((r) => odd.close(() => r()));
    }

    // The rule itself, for a provider set up with a name: its own host and the hosts under it, nothing else.
    const guard = (base: string) => {
      const p = provider(base) as unknown as { socketUrl(l: string): URL };
      return (l: string) => p.socketUrl(l);
    };
    const named = guard('https://api.provider.example');
    for (const good of [
      'wss://api.provider.example/v1/agent?agent_id=a1',
      'wss://eu.api.provider.example/v1/agent?agent_id=a1',
    ])
      expect(named(good).href).toBe(good);
    for (const bad of [
      'wss://evil.example.com/agent',
      'wss://api.provider.example.evil.example/agent',
      'wss://xapi.provider.example/agent',
      'wss://provider.example/agent',
      'wss://api.provider.example./agent',
      'wss://eu.api.provider.example./agent',
      'wss://user:pw@api.provider.example/agent',
      'ws://api.provider.example/agent',
      'https://api.provider.example/agent',
    ])
      expect(() => named(bad)).toThrow('bad link');
    // The local stand-in: the very host and port the Hub is set up with, over ws, and nothing else.
    const local = guard(`http://127.0.0.1:${standin.port}`);
    const own = `ws://127.0.0.1:${standin.port}/__standin/agent-socket?agent_id=a1`;
    expect(local(own).href).toBe(own);
    expect(() => local('ws://127.0.0.1:1/agent')).toThrow('bad link');
    expect(() => local('wss://127.0.0.1/agent')).toThrow('bad link');
  });

  it('keeps a podcast project and a conversation in the notes the rows carry, and judges a link by its parts', () => {
    expect(copyOfCast('pod-1')).toEqual({ kind: 'podcast', id: 'pod-1' });
    expect(endMarkerOfCast('castrun:pod-1')).toBe('podcast:pod-1');
    expect(endMarkerOf('castrun:pod-1')).toBe('podcast:pod-1');
    expect(endMarkerOf('bookrun:3:9000')).toBeUndefined();
    expect(copyOfMarker('podcast:pod-1')?.copy).toEqual({
      kind: 'podcast',
      id: 'pod-1',
    });
    expect(conversationOf('convo:abc-1')).toBe('abc-1');
    expect(conversationOf('convo:abc-1:ended')).toBe('abc-1');
    expect(conversationOf('dub:abc')).toBeNull();
    expect(podcastLinkOk('https://news.example.com/a?b=1')).toBe(true);
    for (const bad of [
      '',
      'http://a.com',
      'https://a',
      'https://1.2.3.4/x',
      'https://u@a.com/x',
      'javascript:alert(1)',
    ])
      expect(podcastLinkOk(bad)).toBe(false);
  });
});
