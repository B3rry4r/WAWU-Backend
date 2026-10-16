import { RealGeminiAdapter, buildChatBody } from '../real-gemini.adapter';
import type { GeminiChatRequest } from '../gemini-client.interface';

/**
 * The request `chat()` builds (FIX-22, LEGAL-01 #3).
 *
 * `fetch` is replaced for the whole file, so no request ever leaves the
 * process and no key is needed: the spec reads the body the adapter would have
 * sent. The "before" body below is written out by hand, exactly as `chat()`
 * built it on main before the `responseSchema` option existed.
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

  const BODY_ON_MAIN = JSON.stringify({
    systemInstruction: { parts: [{ text: 'Be brief.' }] },
    contents: [
      { role: 'user', parts: [{ text: 'Hello' }] },
      { role: 'model', parts: [{ text: 'Hi' }] },
      { role: 'user', parts: [{ text: 'My rent went up' }] },
    ],
    generationConfig: { temperature: 0.3, maxOutputTokens: 700 },
  });

  const schema = {
    type: 'OBJECT',
    properties: { reply: { type: 'STRING' } },
    required: ['reply'],
  };

  it('sends a request with no schema byte for byte as it was before the option existed', async () => {
    const text = await new RealGeminiAdapter().chat(request);
    expect(text).toBe('{"reply":"ok"}');
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toBe(BODY_ON_MAIN);
    expect(sent[0].body).not.toContain('responseMimeType');
    expect(sent[0].body).not.toContain('responseSchema');
    expect(JSON.stringify(buildChatBody(request))).toBe(BODY_ON_MAIN);
  });

  it('treats an absent schema and an undefined one the same', () => {
    expect(
      JSON.stringify(buildChatBody({ ...request, responseSchema: undefined })),
    ).toBe(BODY_ON_MAIN);
  });

  it('sends a schema as responseMimeType application/json and the schema in generationConfig', async () => {
    await new RealGeminiAdapter().chat({ ...request, responseSchema: schema });
    expect(sent).toHaveLength(1);
    const body = JSON.parse(sent[0].body) as Record<string, unknown>;
    expect(body.generationConfig).toEqual({
      temperature: 0.3,
      maxOutputTokens: 700,
      responseMimeType: 'application/json',
      responseSchema: schema,
    });
    // The same keys in the same order as generateBrief() writes them.
    expect(Object.keys(body.generationConfig as object)).toEqual([
      'temperature',
      'maxOutputTokens',
      'responseMimeType',
      'responseSchema',
    ]);
  });

  it('changes nothing else in the body when a schema is passed', async () => {
    await new RealGeminiAdapter().chat({ ...request, responseSchema: schema });
    const body = JSON.parse(sent[0].body) as Record<string, unknown>;
    const before = JSON.parse(BODY_ON_MAIN) as Record<string, unknown>;
    expect(body.systemInstruction).toEqual(before.systemInstruction);
    expect(body.contents).toEqual(before.contents);
  });
});
