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
import { ElevenLabsLegalAi, LEGAL_AGENT_NAME } from '../ai/elevenlabs-legal-ai';
import { parseTurn } from '../assistant/legal-assistant-prompt';
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
    const legal = state().agents.filter((a) => a.name === LEGAL_AGENT_NAME);
    expect(legal).toHaveLength(1);
    const agent = legal[0];
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

  it('reuses the agent; the model setting is read on every turn', async () => {
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
    expect(
      state().agents.filter((a) => a.name === LEGAL_AGENT_NAME),
    ).toHaveLength(1);
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
    const listsBefore = state().agentListReads;
    state().nextAgentReplies.push('{"reply":"x"}');
    await eleven.chat({
      instruction: 'i',
      history: [{ role: 'user', text: 'hi' }],
      responseSchema: SCHEMA,
    });
    expect(state().agents.length).toBe(agentsBefore);
    expect(state().agentPatches.length).toBe(patchesBefore + 1);
    expect(state().agentListReads).toBe(listsBefore);
    expect(state().chats[0].agent).toBe(made.agentId);
    // A pinned agent takes the legal name on its update; it is not part of the agents the other tests count.
    await voice.deleteAgent(made.agentId);
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

  it("hands the reply to the legal parsers as Gemini's goes: a preamble before the JSON is accepted, prose is still a failed turn", async () => {
    const turn = {
      reply: 'Is the lease written?',
      quickReplies: [],
      matter: 'property',
      headline: 'Tenancy',
      facts: [],
      answers: {},
      briefReady: false,
    };
    state().nextAgentReplies.push(
      'Sure, here you go:\n```json\n' + JSON.stringify(turn) + '\n```',
      'No JSON here, only prose.',
    );
    const ask = () =>
      eleven.chat({
        instruction: 'i',
        history: [{ role: 'user', text: 'hi' }],
        responseSchema: SCHEMA,
      });
    expect(parseTurn(await ask()).reply).toBe('Is the lease written?');
    await expect(ask().then(parseTurn)).rejects.toThrow('held no JSON object');
  });

  it("joins a turn that arrives as several responses, up to the platform's end-of-turn event", async () => {
    state().nextAgentReplies.push('{"reply":', '"split"}');
    const out = await eleven.chat({
      instruction: 'i',
      history: [{ role: 'user', text: 'hi [[parts]]' }],
      responseSchema: SCHEMA,
    });
    expect(out).toBe('{"reply":\n\n"split"}');
  });

  it('three boots with no pin make exactly one agent, found by its exact name', async () => {
    const named = () =>
      state().agents.filter((a) => a.name === LEGAL_AGENT_NAME).length;
    const before = named();
    for (let i = 0; i < 3; i += 1) {
      const boot = new ElevenLabsLegalAi(voice, settingsOf(values));
      boot.cleanupDelaysMs = [20];
      state().nextAgentReplies.push('{"reply":"x"}');
      await boot.chat({
        instruction: 'i',
        history: [{ role: 'user', text: 'hi' }],
        responseSchema: SCHEMA,
      });
    }
    expect(named()).toBe(Math.max(before, 1));
    // An agent of another name, or one that only contains the name, is never taken for it.
    await voice.createAgent({
      name: `${LEGAL_AGENT_NAME} copy`,
      prompt: 'p',
      firstMessage: '',
      language: 'en',
      llm: 'gemini-3-flash-preview',
      voiceId: '',
      knowledge: [],
      allowOverrides: { prompt: true },
    });
    expect(await voice.listAgentsNamed(LEGAL_AGENT_NAME)).toHaveLength(
      Math.max(before, 1),
    );
  });

  it('reads the agent list across pages', async () => {
    state().agentListPageSize = 1;
    try {
      const found = await voice.listAgentsNamed(LEGAL_AGENT_NAME);
      expect(found.length).toBeGreaterThanOrEqual(1);
      expect(
        found.every(
          (a, i) => i === 0 || a.createdUnix >= found[i - 1].createdUnix,
        ),
      ).toBe(true);
    } finally {
      state().agentListPageSize = 0;
    }
  });

  it('two Hubs booting at the same moment end with one agent', async () => {
    const racing = new HttpVoiceProvider(
      new ConfigService({
        AI_VOICE_BASE_URL: `http://127.0.0.1:${standin.port}`,
        AI_VOICE_API_KEY: KEY,
      }),
    );
    // A fresh name-space: delete every legal agent so both boots find none and both create.
    for (const a of await voice.listAgentsNamed(LEGAL_AGENT_NAME))
      await voice.deleteAgent(a.agentId);
    const one = new ElevenLabsLegalAi(voice, settingsOf(values));
    const two = new ElevenLabsLegalAi(racing, settingsOf(values));
    one.cleanupDelaysMs = two.cleanupDelaysMs = [20];
    state().nextAgentReplies.push('{"reply":"a"}', '{"reply":"b"}');
    await Promise.all(
      [one, two].map((c) =>
        c.chat({
          instruction: 'i',
          history: [{ role: 'user', text: 'hi' }],
          responseSchema: SCHEMA,
        }),
      ),
    );
    expect(await voice.listAgentsNamed(LEGAL_AGENT_NAME)).toHaveLength(1);
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
    state().nextAgentReplies.push(
      'Here is the brief: {"summary":"S","keyIssues":[],"questionsToClarify":[]} Hope that helps.',
    );
    expect(
      (await eleven.generateBrief({ instruction: 'i', content: 'c' })).summary,
    ).toBe('S');
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
      eleven.generateBrief({ instruction: 'i', content: 'two' }),
    ).rejects.toThrow('unparseable');
    await wait(() => state().deletedConversations.length >= 2);
    expect(state().deletedConversations).toHaveLength(2);
  });

  it('turns a provider capacity answer into the 429 text the assistant already reads', async () => {
    const down = {
      agentsConfigured: true,
      listAgentsNamed: () => Promise.resolve([]),
      deleteAgent: () => Promise.resolve('deleted'),
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
    // Not set up on this server: the setting says elevenlabs, the picker still uses today's Gemini path.
    const unset = new ElevenLabsLegalAi(
      { agentsConfigured: false } as unknown as AiVoiceProvider,
      settingsOf(values),
    );
    const bare = new LegalAiClient(settingsOf(values), gemini as never, unset);
    expect(await bare.chat({ instruction: 'i', history: [] })).toBe('g');
    seen.length = 0;
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
