import { Logger } from '@nestjs/common';
import {
  GEMINI_THINKING_LEVEL,
  MAX_OUTPUT_TOKENS,
  RealGeminiAdapter,
  buildChatBody,
} from '../real-gemini.adapter';
import type { GeminiChatRequest } from '../gemini-client.interface';

/**
 * The request `chat()` builds (FIX-22, LEGAL-01 #3).
 *
 * `fetch` is replaced for the whole file, so no request ever leaves the
 * process and no key is needed: the spec reads the body the adapter would have
 * sent. The no-schema body below is written out by hand. FIX-43 changed its
 * `generationConfig` (a thinking level and a limit with room for thinking), so
 * it is pinned here with those values.
 */
describe('RealGeminiAdapter chat request (FIX-22)', () => {
  const realFetch = global.fetch;
  const realKey = process.env.GEMINI_API_KEY;
  let sent: Array<{ url: string; body: string }>;

  beforeEach(() => {
    sent = [];
    process.env.GEMINI_API_KEY = 'stand-in-key';
    global.fetch = jest.fn((url: string, init: { body: string }) => {
      sent.push({ url, body: init.body });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            candidates: [
              { content: { parts: [{ text: ' {"reply":"ok"} ' }] } },
            ],
          }),
          { status: 200 },
        ),
      );
    });
  });

  afterEach(() => {
    global.fetch = realFetch;
    if (realKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = realKey;
  });

  const request: GeminiChatRequest = {
    instruction: 'Be brief.',
    history: [
      { role: 'user', text: 'Hello' },
      { role: 'model', text: 'Hi' },
      { role: 'user', text: 'My rent went up' },
    ],
  };

  const BODY_NO_SCHEMA = JSON.stringify({
    systemInstruction: { parts: [{ text: 'Be brief.' }] },
    contents: [
      { role: 'user', parts: [{ text: 'Hello' }] },
      { role: 'model', parts: [{ text: 'Hi' }] },
      { role: 'user', parts: [{ text: 'My rent went up' }] },
    ],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 3072,
      thinkingConfig: { thinkingLevel: 'LOW' },
    },
  });

  const schema = {
    type: 'OBJECT',
    properties: { reply: { type: 'STRING' } },
    required: ['reply'],
  };

  it('sends a request with no schema as plain prose, with the thinking level and the new limit', async () => {
    const text = await new RealGeminiAdapter().chat(request);
    expect(text).toBe('{"reply":"ok"}');
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toBe(BODY_NO_SCHEMA);
    expect(sent[0].body).not.toContain('responseMimeType');
    expect(sent[0].body).not.toContain('responseSchema');
    expect(JSON.stringify(buildChatBody(request))).toBe(BODY_NO_SCHEMA);
  });

  it('treats an absent schema and an undefined one the same', () => {
    expect(
      JSON.stringify(buildChatBody({ ...request, responseSchema: undefined })),
    ).toBe(BODY_NO_SCHEMA);
  });

  it('sends a schema as responseMimeType application/json and the schema in generationConfig', async () => {
    await new RealGeminiAdapter().chat({ ...request, responseSchema: schema });
    expect(sent).toHaveLength(1);
    const body = JSON.parse(sent[0].body) as Record<string, unknown>;
    expect(body.generationConfig).toEqual({
      temperature: 0.3,
      maxOutputTokens: 4096,
      thinkingConfig: { thinkingLevel: 'LOW' },
      responseMimeType: 'application/json',
      responseSchema: schema,
    });
    // The same keys in the same order as generateBrief() writes them.
    expect(Object.keys(body.generationConfig as object)).toEqual([
      'temperature',
      'maxOutputTokens',
      'thinkingConfig',
      'responseMimeType',
      'responseSchema',
    ]);
  });

  it('changes nothing else in the body when a schema is passed', async () => {
    await new RealGeminiAdapter().chat({ ...request, responseSchema: schema });
    const body = JSON.parse(sent[0].body) as Record<string, unknown>;
    const before = JSON.parse(BODY_NO_SCHEMA) as Record<string, unknown>;
    expect(body.systemInstruction).toEqual(before.systemInstruction);
    expect(body.contents).toEqual(before.contents);
  });
});

/**
 * FIX-43: thinking tokens count against maxOutputTokens. The live profiling
 * turn came back MAX_TOKENS with 669 thought tokens and a 58 character
 * fragment. No request leaves the process: `fetch` is a stand-in.
 */
describe('RealGeminiAdapter thinking and truncation (FIX-43)', () => {
  const realFetch = global.fetch;
  const realKey = process.env.GEMINI_API_KEY;
  let sent: Array<{ url: string; body: string }>;
  let answer: unknown;
  let logged: string[];
  let errorSpy: jest.SpyInstance;

  const schema = {
    type: 'OBJECT',
    properties: { reply: { type: 'STRING' } },
    required: ['reply'],
  };
  const chatRequest: GeminiChatRequest = {
    instruction: 'Be brief.',
    history: [{ role: 'user', text: 'My landlord changed the locks' }],
  };
  const briefRequest = {
    instruction: 'Summarise.',
    content: 'A rent dispute.',
  };

  beforeEach(() => {
    sent = [];
    logged = [];
    process.env.GEMINI_API_KEY = 'stand-in-key';
    answer = {
      candidates: [
        { content: { parts: [{ text: '{}' }] }, finishReason: 'STOP' },
      ],
    };
    global.fetch = jest.fn((url: string, init: { body: string }) => {
      sent.push({ url, body: init.body });
      return Promise.resolve(
        new Response(JSON.stringify(answer), { status: 200 }),
      );
    });
    errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation((message: unknown) => {
        logged.push(String(message));
      });
  });

  afterEach(() => {
    global.fetch = realFetch;
    errorSpy.mockRestore();
    if (realKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = realKey;
  });

  const generationConfig = (): Record<string, unknown> =>
    (JSON.parse(sent[0].body) as { generationConfig: Record<string, unknown> })
      .generationConfig;

  describe('the request body', () => {
    it('chat with a schema carries the thinking level and room for thinking and the answer', async () => {
      await new RealGeminiAdapter().chat({
        ...chatRequest,
        responseSchema: schema,
      });
      const config = generationConfig();
      expect(config.thinkingConfig).toEqual({ thinkingLevel: 'LOW' });
      expect(config.maxOutputTokens).toBe(MAX_OUTPUT_TOKENS.chatJson);
      // The 700 that was spent 669 on thinking is gone, and the new limit is
      // well past what a full turn needs after thinking.
      expect(MAX_OUTPUT_TOKENS.chatJson).toBeGreaterThanOrEqual(4096);
    });

    it('chat without a schema carries the thinking level and the prose limit', async () => {
      await new RealGeminiAdapter().chat(chatRequest);
      const config = generationConfig();
      expect(config.thinkingConfig).toEqual({ thinkingLevel: 'LOW' });
      expect(config.maxOutputTokens).toBe(MAX_OUTPUT_TOKENS.chatProse);
      expect(MAX_OUTPUT_TOKENS.chatProse).toBeGreaterThan(700);
    });

    it('generateBrief carries the thinking level and the new limit', async () => {
      answer = {
        candidates: [
          {
            content: {
              parts: [
                {
                  text: '{"summary":"s","keyIssues":[],"questionsToClarify":[]}',
                },
              ],
            },
            finishReason: 'STOP',
          },
        ],
      };
      await new RealGeminiAdapter().generateBrief(briefRequest);
      const config = generationConfig();
      expect(config.thinkingConfig).toEqual({ thinkingLevel: 'LOW' });
      expect(config.maxOutputTokens).toBe(MAX_OUTPUT_TOKENS.brief);
      expect(MAX_OUTPUT_TOKENS.brief).toBeGreaterThan(1200);
    });

    it('buildChatBody uses the same thinking level as the constant', () => {
      const body = buildChatBody(chatRequest) as {
        generationConfig: { thinkingConfig: { thinkingLevel: string } };
      };
      expect(body.generationConfig.thinkingConfig.thinkingLevel).toBe(
        GEMINI_THINKING_LEVEL,
      );
    });
  });

  describe('reading the answer', () => {
    const withThoughtFirst = {
      candidates: [
        {
          content: {
            parts: [
              { text: 'Considering what the client asked...', thought: true },
              { text: '{"reply":"Your landlord ' },
              { text: 'cannot do that."}' },
            ],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { thoughtsTokenCount: 120, candidatesTokenCount: 20 },
    };

    it('chat joins the parts that are not thoughts, whatever order they come in', async () => {
      answer = withThoughtFirst;
      const text = await new RealGeminiAdapter().chat({
        ...chatRequest,
        responseSchema: schema,
      });
      expect(text).toBe('{"reply":"Your landlord cannot do that."}');
      expect(JSON.parse(text)).toEqual({
        reply: 'Your landlord cannot do that.',
      });
      expect(logged).toEqual([]);
    });

    it('generateBrief parses the JSON that follows a thought part', async () => {
      answer = {
        candidates: [
          {
            content: {
              parts: [
                { text: 'Thinking about the dispute...', thought: true },
                {
                  text: '{"summary":"A rent dispute.","keyIssues":["notice"],"questionsToClarify":[]}',
                },
              ],
            },
            finishReason: 'STOP',
          },
        ],
      };
      const brief = await new RealGeminiAdapter().generateBrief(briefRequest);
      expect(brief.summary).toBe('A rent dispute.');
      expect(brief.keyIssues).toEqual(['notice']);
    });
  });

  describe('an answer that did not finish', () => {
    const cutOff = {
      candidates: [
        {
          content: { parts: [{ text: 'A fragment that was cut of' }] },
          finishReason: 'MAX_TOKENS',
        },
      ],
      usageMetadata: {
        promptTokenCount: 412,
        candidatesTokenCount: 17,
        thoughtsTokenCount: 669,
        totalTokenCount: 1098,
      },
    };

    it('chat fails cleanly and logs the reason and counts once, never the text', async () => {
      answer = cutOff;
      await expect(
        new RealGeminiAdapter().chat({
          ...chatRequest,
          responseSchema: schema,
        }),
      ).rejects.toThrow('Gemini chat ended early: MAX_TOKENS');
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain('MAX_TOKENS');
      expect(logged[0]).toContain('thoughts 669');
      expect(logged[0]).toContain('answer 17');
      expect(logged[0]).toContain('prompt 412');
      expect(logged[0]).toContain('total 1098');
      expect(logged[0]).not.toContain('fragment');
    });

    it('generateBrief fails the same way', async () => {
      answer = cutOff;
      await expect(
        new RealGeminiAdapter().generateBrief(briefRequest),
      ).rejects.toThrow('Gemini brief ended early: MAX_TOKENS');
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain('thoughts 669');
    });

    it.each(['SAFETY', 'RECITATION', 'OTHER'])(
      'treats finishReason %s as a failed turn too',
      async (reason) => {
        answer = {
          candidates: [
            {
              content: { parts: [{ text: '{"reply":"x"}' }] },
              finishReason: reason,
            },
          ],
        };
        await expect(new RealGeminiAdapter().chat(chatRequest)).rejects.toThrow(
          reason,
        );
        expect(logged).toHaveLength(1);
        expect(logged[0]).toContain(reason);
        expect(logged[0]).toContain('thoughts ?');
      },
    );
  });
});
