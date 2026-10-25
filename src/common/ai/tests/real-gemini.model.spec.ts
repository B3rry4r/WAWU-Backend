import { Logger } from '@nestjs/common';
import {
  DEFAULT_GEMINI_MODEL,
  GEMINI_MODEL,
  RealGeminiAdapter,
  buildChatBody,
  resolveGeminiModel,
  thinkingConfigFor,
} from '../real-gemini.adapter';
import type { GeminiChatRequest } from '../gemini-client.interface';

/**
 * R2-LEGAL: the Legal chat stayed silent.
 *
 * Two causes, both about which model the Hub asks:
 * 1. Every call carried `thinkingConfig.thinkingLevel`, which only the Gemini 3
 *    family accepts. A Hub pointed at `gemini-2.5-flash` (which a direct probe
 *    answers 200) got HTTP 400 "Thinking level is not supported for this
 *    model" on every turn, so the assistant never replied.
 * 2. The default model id, `gemini-3.7-flash`, answered 503 "high demand" or
 *    nothing inside the 20 second limit on the day it was checked. The default
 *    is now a model that answered every probe, and it comes from
 *    `GEMINI_MODEL`, where an empty value (a copied `.env.example` line) no
 *    longer becomes an empty model name.
 *
 * `fetch` is replaced, so no request leaves the process and no key is needed.
 */
describe('the Gemini model id comes from config (R2-LEGAL)', () => {
  it('uses GEMINI_MODEL when it is set', () => {
    expect(resolveGeminiModel('gemini-2.5-flash')).toBe('gemini-2.5-flash');
    expect(resolveGeminiModel('  gemini-3.5-flash  ')).toBe('gemini-3.5-flash');
  });

  it('falls back to the default when it is unset, empty or only spaces', () => {
    expect(resolveGeminiModel(undefined)).toBe(DEFAULT_GEMINI_MODEL);
    expect(resolveGeminiModel('')).toBe(DEFAULT_GEMINI_MODEL);
    expect(resolveGeminiModel('   ')).toBe(DEFAULT_GEMINI_MODEL);
  });

  it('defaults to a Gemini 3 flash model that is not the one that answered 503', () => {
    expect(DEFAULT_GEMINI_MODEL).toBe('gemini-3-flash-preview');
    expect(DEFAULT_GEMINI_MODEL).not.toBe('gemini-3.7-flash');
    // A family the thinking setting knows, so the default never sends a
    // request its own model refuses.
    expect(thinkingConfigFor(DEFAULT_GEMINI_MODEL)).toEqual({
      thinkingLevel: 'LOW',
    });
  });

  it('the exported model is the resolved one', () => {
    expect(GEMINI_MODEL).toBe(resolveGeminiModel(process.env.GEMINI_MODEL));
  });
});

describe('the thinking setting follows the model family (R2-LEGAL)', () => {
  it('a Gemini 3 model gets a thinking level', () => {
    expect(thinkingConfigFor('gemini-3.5-flash')).toEqual({
      thinkingLevel: 'LOW',
    });
    expect(thinkingConfigFor('gemini-3.1-flash-lite')).toEqual({
      thinkingLevel: 'LOW',
    });
    expect(thinkingConfigFor('gemini-3-flash-preview')).toEqual({
      thinkingLevel: 'LOW',
    });
  });

  it('a Gemini 2.5 model gets a thinking budget and never a level', () => {
    const config = thinkingConfigFor('gemini-2.5-flash');
    expect(config).toEqual({ thinkingBudget: 1024 });
    expect(config).not.toHaveProperty('thinkingLevel');
    expect(thinkingConfigFor('gemini-2.5-flash-lite')).toEqual({
      thinkingBudget: 1024,
    });
  });

  it('a model of unknown family (an alias, a newer name) gets no thinking setting at all', () => {
    expect(thinkingConfigFor('gemini-flash-latest')).toBeUndefined();
    expect(thinkingConfigFor('gemini-4-flash')).toBeUndefined();
  });
});

describe('RealGeminiAdapter sends what the configured model accepts (R2-LEGAL)', () => {
  const realFetch = global.fetch;
  const realKey = process.env.GEMINI_API_KEY;
  const realModel = process.env.GEMINI_MODEL;
  let sent: Array<{ url: string; body: string }>;
  let errorSpy: jest.SpyInstance;

  const request: GeminiChatRequest = {
    instruction: 'Be brief.',
    history: [{ role: 'user', text: 'A client has not paid me.' }],
    responseSchema: {
      type: 'OBJECT',
      properties: { reply: { type: 'STRING' } },
      required: ['reply'],
    },
  };

  beforeEach(() => {
    sent = [];
    process.env.GEMINI_API_KEY = 'stand-in-key';
    global.fetch = jest.fn((url: string, init: { body: string }) => {
      sent.push({ url, body: init.body });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: { parts: [{ text: '{"reply":"Where are you?"}' }] },
                finishReason: 'STOP',
              },
            ],
          }),
          { status: 200 },
        ),
      );
    });
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => {
    global.fetch = realFetch;
    errorSpy.mockRestore();
    if (realKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = realKey;
    if (realModel === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = realModel;
  });

  const config = (): Record<string, unknown> =>
    (JSON.parse(sent[0].body) as { generationConfig: Record<string, unknown> })
      .generationConfig;

  it('asks the model GEMINI_MODEL names, in the URL', async () => {
    process.env.GEMINI_MODEL = 'gemini-3.5-flash';
    await new RealGeminiAdapter().chat(request);
    expect(sent[0].url).toContain('/models/gemini-3.5-flash:generateContent');
  });

  it('a Hub with GEMINI_MODEL empty asks the default model, not a model with no name', async () => {
    process.env.GEMINI_MODEL = '';
    await new RealGeminiAdapter().chat(request);
    expect(sent[0].url).toContain(
      `/models/${DEFAULT_GEMINI_MODEL}:generateContent`,
    );
  });

  it('a chat turn on gemini-2.5-flash carries no thinkingLevel (the provider answers 400 to one)', async () => {
    process.env.GEMINI_MODEL = 'gemini-2.5-flash';
    await new RealGeminiAdapter().chat(request);
    expect(sent[0].body).not.toContain('thinkingLevel');
    expect(config().thinkingConfig).toEqual({ thinkingBudget: 1024 });
  });

  it('a brief on gemini-2.5-flash carries no thinkingLevel either', async () => {
    process.env.GEMINI_MODEL = 'gemini-2.5-flash';
    (global.fetch as jest.Mock).mockImplementationOnce(
      (url: string, init: { body: string }) => {
        sent.push({ url, body: init.body });
        return Promise.resolve(
          new Response(
            JSON.stringify({
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
            }),
            { status: 200 },
          ),
        );
      },
    );
    await new RealGeminiAdapter().generateBrief({
      instruction: 'Summarise.',
      content: 'A rent dispute.',
    });
    expect(sent[0].body).not.toContain('thinkingLevel');
  });

  it('a chat turn on a model of unknown family sends no thinkingConfig, and keeps the room for thinking', async () => {
    process.env.GEMINI_MODEL = 'gemini-flash-latest';
    await new RealGeminiAdapter().chat(request);
    expect(config()).not.toHaveProperty('thinkingConfig');
    expect(config().maxOutputTokens).toBeGreaterThanOrEqual(4096);
  });

  it('buildChatBody takes the model, and defaults to the configured one', () => {
    const body = (model?: string) =>
      buildChatBody(request, model) as {
        generationConfig: { thinkingConfig?: Record<string, unknown> };
      };
    expect(body('gemini-2.5-flash').generationConfig.thinkingConfig).toEqual({
      thinkingBudget: 1024,
    });
    expect(body('gemini-3.5-flash').generationConfig.thinkingConfig).toEqual({
      thinkingLevel: 'LOW',
    });
    expect(body().generationConfig.thinkingConfig).toEqual(
      thinkingConfigFor(GEMINI_MODEL),
    );
  });
});
