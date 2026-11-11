// LEGAL-ELEVEN (R-137): the legal assistant's AI client on the agent platform. The REAL HTTP voice adapter against the
// voice stand-in on this machine (scripts/dev/voice-standin.cjs, with its agent socket). Never the live provider.
import { ConfigService } from '@nestjs/config';
import { HttpVoiceProvider } from '../../ai-tools/voice/http-voice-provider';
import {
  AiVoiceProviderError,
  AGENT_PRIVACY,
  type AiVoiceProvider,
} from '../../ai-tools/voice/ai-voice-provider';
import type { PlanSettingsService } from '../../plan-settings/plan-settings.service';
import type { GeminiClient } from '../../common/ai/gemini-client.interface';
import { GEMINI_MODEL } from '../../common/ai/real-gemini.adapter';
import {
  startStandin,
  type StandinHandle,
} from '../../../test/ai-tools/voice-standin-for-specs';
import { providerAtCapacity } from '../assistant/legal-assistant.service';
import { ElevenLabsLegalAi, readJsonObject } from '../ai/elevenlabs-legal-ai';
import { LegalAiClient, modelLabelOf } from '../ai/legal-ai.client';

const KEY = 'legal-eleven-spec-key';
const SCHEMA = {
  type: 'OBJECT',
  properties: { reply: { type: 'STRING' } },
  required: ['reply'],
};

function settingsOf(values: Record<string, string[]>): PlanSettingsService {
  return {
    lines: (key: string) => values[key] ?? [],
  } as unknown as PlanSettingsService;
}

const wait = async (until: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!until() && Date.now() < end)
    await new Promise((r) => setTimeout(r, 20));
};

describe('LEGAL-ELEVEN: the legal AI client on the agent platform', () => {
  let standin: StandinHandle;
  let values: Record<string, string[]>;
  let voice: HttpVoiceProvider;
  let eleven: ElevenLabsLegalAi;
  const state = () => standin.state;

  beforeAll(async () => {
    standin = await startStandin(KEY);
  });
  afterAll(async () => {
    await new Promise<void>((r) => standin.server.close(() => r()));
  });
  beforeEach(() => {
    values = {
      'legal.ai_llm': ['gemini-3-flash-preview'],
      'legal.ai_provider': ['elevenlabs'],
      'legal.ai_agent_id': [],
    };
    voice = new HttpVoiceProvider(
      new ConfigService({
        AI_VOICE_BASE_URL: `http://127.0.0.1:${standin.port}`,
        AI_VOICE_API_KEY: KEY,
      }),
    );
    eleven = new ElevenLabsLegalAi(voice, settingsOf(values));
    eleven.cleanupDelaysMs = [20, 20, 20, 20];
    state().chats.length = 0;
    state().nextAgentReplies.length = 0;
  });

  it('asks one text-only agent conversation per turn, with the instruction and model of that turn and nothing else', async () => {
    const agentsBefore = state().agents.length;
    state().nextAgentReplies.push('{"reply":"Is the lease written?"}');
    const raw = await eleven.chat({
      instruction: 'INSTRUCTION-ONE',
      history: [
        { role: 'user', text: 'first words' },
        { role: 'model', text: 'first answer' },
        { role: 'user', text: 'second words' },
      ],
      responseSchema: SCHEMA,
    });
    expect(JSON.parse(raw)).toEqual({ reply: 'Is the lease written?' });
    const agent = state().agents[agentsBefore];
    expect(state().agents.length).toBe(agentsBefore + 1);
    expect(agent.firstMessage).toBe('');
    expect(agent.overrides).toEqual({ prompt: true, llm: true });
    expect(agent.textOnlyOverride).toBe(true);
    expect(agent.privacy).toEqual({ ...AGENT_PRIVACY });
    expect(agent.voice).toBeNull();
    expect(state().chats).toHaveLength(1);
    const chat = state().chats[0];
    expect(chat.textOnly).toBe(true);
    expect(chat.keyLeak).toBe(false);
    expect(chat.override?.allowed).toBe(true);
    expect(chat.override?.llm).toBe('gemini-3-flash-preview');
    expect(chat.override?.prompt).toContain('INSTRUCTION-ONE');
    expect(chat.override?.prompt).toContain(JSON.stringify(SCHEMA));
    expect(chat.earlier).toBe(true);
    expect(chat.message).toContain('first words');
    expect(chat.message).toContain('first answer');
    expect(chat.message).toContain('second words');
  });

  it('makes the agent once and reuses it; the model setting is read on every turn', async () => {
    const agentsBefore = state().agents.length;
    state().nextAgentReplies.push('{"reply":"a"}', '{"reply":"b"}');
    await eleven.chat({
      instruction: 'i',
      history: [{ role: 'user', text: 'one' }],
      responseSchema: SCHEMA,
    });
    values['legal.ai_llm'] = ['claude-sonnet-4-5'];
    await eleven.chat({
      instruction: 'i',
      history: [{ role: 'user', text: 'two' }],
      responseSchema: SCHEMA,
    });
    expect(state().agents.length).toBe(agentsBefore + 1);
    expect(state().chats.map((c) => c.override?.llm)).toEqual([
      'gemini-3-flash-preview',
      'claude-sonnet-4-5',
    ]);
    expect(eleven.modelLabel()).toBe('elevenlabs:claude-sonnet-4-5');
  });

  it('brings a pinned agent to the Hub settings instead of making another', async () => {
    const made = await voice.createAgent({
      name: 'pinned',
      prompt: 'p',
      firstMessage: '',
      language: 'en',
      llm: 'gemini-3-flash-preview',
      voiceId: '',
      knowledge: [],
      allowOverrides: { prompt: true, llm: true },
    });
    values['legal.ai_agent_id'] = [made.agentId];
    const agentsBefore = state().agents.length;
    const patchesBefore = state().agentPatches.length;
    state().nextAgentReplies.push('{"reply":"x"}');
    await eleven.chat({
      instruction: 'i',
      history: [{ role: 'user', text: 'hi' }],
      responseSchema: SCHEMA,
    });
    expect(state().agents.length).toBe(agentsBefore);
    expect(state().agentPatches.length).toBe(patchesBefore + 1);
    expect(state().chats[0].agent).toBe(made.agentId);
  });

  it('gives a prose turn back as it came, with no schema asked for', async () => {
    state().nextAgentReplies.push('  Plain words.  ');
    const out = await eleven.chat({
      instruction: 'PLAIN',
      history: [{ role: 'user', text: 'hello' }],
    });
    expect(out).toBe('Plain words.');
    expect(state().chats[0].override?.prompt).toBe('PLAIN');
  });

  it('fails a reply that is not one JSON object, exactly as an unparseable Gemini answer', async () => {
    for (const bad of ['not json at all', '[1,2]', '"text"', '{"reply":']) {
      state().nextAgentReplies.push(bad);
      await expect(
        eleven.chat({
          instruction: 'i',
          history: [{ role: 'user', text: 'hi' }],
          responseSchema: SCHEMA,
        }),
      ).rejects.toThrow('Legal chat returned unparseable JSON');
    }
    state().nextAgentReplies.push('```json\n{"reply":"fenced"}\n```');
    const ok = await eleven.chat({
      instruction: 'i',
      history: [{ role: 'user', text: 'hi' }],
      responseSchema: SCHEMA,
    });
    expect(readJsonObject(ok)).toEqual({ reply: 'fenced' });
  });

  it('has no turn to answer when the newest line is not the person', async () => {
    await expect(
      eleven.chat({
        instruction: 'i',
        history: [{ role: 'model', text: 'only me' }],
      }),
    ).rejects.toThrow('no message to answer');
    expect(state().chats).toHaveLength(0);
  });

  it('writes the brief as a text-only conversation and shapes it like the Gemini brief', async () => {
    state().nextAgentReplies.push(
      JSON.stringify({
        summary: ' A tenant faces a rent rise. ',
        keyIssues: ['Rent review', 7, ''],
        questionsToClarify: ['What does the clause say?'],
      }),
    );
    const brief = await eleven.generateBrief({
      instruction: 'BRIEF-INSTRUCTION',
      content: 'Matter: property\nRent rise: 60%',
    });
    expect(brief).toEqual({
      summary: 'A tenant faces a rent rise.',
      keyIssues: ['Rent review'],
      questionsToClarify: ['What does the clause say?'],
      risks: [],
    });
    const chat = state().chats[0];
    expect(chat.textOnly).toBe(true);
    expect(chat.override?.prompt).toContain('BRIEF-INSTRUCTION');
    expect(chat.message).toBe('Matter: property\nRent rise: 60%');
    state().nextAgentReplies.push('nope');
    await expect(
      eleven.generateBrief({ instruction: 'i', content: 'c' }),
    ).rejects.toThrow('unparseable JSON');
  });

  it('deletes each conversation after its turn, a failed one too, and keeps none', async () => {
    // Earlier tests' conversations finish deleting in the background first.
    await new Promise((r) => setTimeout(r, 400));
    state().deletedConversations.length = 0;
    state().nextAgentReplies.push('{"reply":"ok"}', 'garbage');
    await eleven.chat({
      instruction: 'i',
      history: [{ role: 'user', text: 'one' }],
      responseSchema: SCHEMA,
    });
    await expect(
      eleven.chat({
        instruction: 'i',
        history: [{ role: 'user', text: 'two' }],
        responseSchema: SCHEMA,
      }),
    ).rejects.toThrow('unparseable');
    await wait(() => state().deletedConversations.length >= 2);
    expect(state().deletedConversations).toHaveLength(2);
  });

  it('turns a provider capacity answer into the 429 text the assistant already reads', async () => {
    const down = {
      agentsConfigured: true,
      updateAgent: () => Promise.resolve(),
      createAgent: () => Promise.resolve({ agentId: 'agent-x1234567' }),
      askAgent: () =>
        Promise.reject(new AiVoiceProviderError('unavailable', 'x', 429)),
    } as unknown as AiVoiceProvider;
    const busy = new ElevenLabsLegalAi(down, settingsOf(values));
    const err = await busy
      .chat({ instruction: 'i', history: [{ role: 'user', text: 'hi' }] })
      .catch((e: unknown) => e);
    expect(providerAtCapacity(err)).toBe(true);
    const other = {
      ...down,
      askAgent: () =>
        Promise.reject(new AiVoiceProviderError('unavailable', 'no answer')),
    } as unknown as AiVoiceProvider;
    const failed = await new ElevenLabsLegalAi(other, settingsOf(values))
      .chat({ instruction: 'i', history: [{ role: 'user', text: 'hi' }] })
      .catch((e: unknown) => e);
    expect(providerAtCapacity(failed)).toBe(false);
    expect((failed as Error).message).toContain('failed');
  });

  it('answers as an unavailable AI when the provider keys are not set, calling nothing', async () => {
    const calls: string[] = [];
    const off = {
      agentsConfigured: false,
      createAgent: () => (calls.push('create'), Promise.reject(new Error())),
      askAgent: () => (calls.push('ask'), Promise.reject(new Error())),
    } as unknown as AiVoiceProvider;
    const idle = new ElevenLabsLegalAi(off, settingsOf(values));
    await expect(
      idle.chat({ instruction: 'i', history: [{ role: 'user', text: 'hi' }] }),
    ).rejects.toThrow('AI_VOICE_API_KEY is not set');
    await expect(
      idle.generateBrief({ instruction: 'i', content: 'c' }),
    ).rejects.toThrow('AI_VOICE_API_KEY is not set');
    expect(calls).toEqual([]);
  });

  it('is picked by legal.ai_provider on every call, and gemini brings the earlier path back untouched', async () => {
    const seen: string[] = [];
    const gemini = {
      chat: () => (seen.push('gemini'), Promise.resolve('g')),
      generateBrief: () => (
        seen.push('gemini-brief'),
        Promise.resolve({
          summary: 's',
          keyIssues: [],
          questionsToClarify: [],
          risks: [],
        })
      ),
    } as unknown as GeminiClient;
    const router = new LegalAiClient(
      settingsOf(values),
      gemini as never,
      eleven,
    );
    state().nextAgentReplies.push('from the agent');
    expect(
      await router.chat({
        instruction: 'i',
        history: [{ role: 'user', text: 'hi' }],
      }),
    ).toBe('from the agent');
    expect(modelLabelOf(router)).toBe('elevenlabs:gemini-3-flash-preview');
    values['legal.ai_provider'] = ['gemini'];
    expect(
      await router.chat({
        instruction: 'i',
        history: [{ role: 'user', text: 'hi' }],
      }),
    ).toBe('g');
    await router.generateBrief({ instruction: 'i', content: 'c' });
    expect(seen).toEqual(['gemini', 'gemini-brief']);
    expect(state().chats).toHaveLength(1);
    expect(modelLabelOf(router)).toBe(GEMINI_MODEL);
    expect(modelLabelOf({} as GeminiClient)).toBe(GEMINI_MODEL);
  });
});
