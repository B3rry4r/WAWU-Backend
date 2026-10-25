import { LegalAssistantService } from '../legal-assistant.service';
import {
  buildTurnSchema,
  parseTurn,
  questionsForModel,
  validAnswers,
} from '../legal-assistant-prompt';
import { ASSISTANT_LIMITS } from '../legal-assistant-config';
import {
  LEGAL_MATTER_VALUES,
  questionsForMatter,
} from '../../legal-intake-questions';
import type {
  GeminiBrief,
  GeminiChatRequest,
  GeminiClient,
} from '../../../common/ai/gemini-client.interface';

/**
 * The profiling turn asks the model for one JSON object (FIX-22, LEGAL-01 #3).
 *
 * No provider, no database: the AI is a stand-in at its seam (GEMINI_CLIENT's
 * interface) that records each request and answers from a queue, so nothing
 * here calls a real model.
 */

type Schema = {
  type: string;
  properties?: Record<string, Schema>;
  required?: string[];
  enum?: string[];
  items?: Schema;
  maxItems?: number;
  nullable?: boolean;
};

/** Every object node in a schema, with the path to it. */
function objectNodes(node: Schema, path = '$'): Array<[string, Schema]> {
  const found: Array<[string, Schema]> = [];
  if (node.type === 'OBJECT') found.push([path, node]);
  for (const [key, child] of Object.entries(node.properties ?? {})) {
    found.push(...objectNodes(child, `${path}.${key}`));
  }
  if (node.items) found.push(...objectNodes(node.items, `${path}[]`));
  return found;
}

describe('buildTurnSchema', () => {
  it.each(LEGAL_MATTER_VALUES)(
    'names the instruction keys, requires them, and leaves no empty object for %s',
    (matter) => {
      const schema = buildTurnSchema(matter) as Schema;
      expect(schema.type).toBe('OBJECT');
      expect(Object.keys(schema.properties ?? {}).sort()).toEqual(
        [
          'answers',
          'briefReady',
          'facts',
          'headline',
          'matter',
          'quickReplies',
          'reply',
        ].sort(),
      );
      expect([...(schema.required ?? [])].sort()).toEqual(
        Object.keys(schema.properties ?? {}).sort(),
      );
      // The provider refuses an OBJECT with no properties.
      for (const [path, node] of objectNodes(schema)) {
        expect([path, Object.keys(node.properties ?? {}).length > 0]).toEqual([
          path,
          true,
        ]);
      }
    },
  );

  it('limits the matter to the fourteen values (or null) and the lists to the server limits', () => {
    const p = (buildTurnSchema('other') as Schema).properties!;
    expect(p.matter.enum).toEqual([...LEGAL_MATTER_VALUES]);
    expect(p.matter.nullable).toBe(true);
    expect(p.headline.nullable).toBe(true);
    expect(p.quickReplies.maxItems).toBe(ASSISTANT_LIMITS.quickReplies);
    expect(p.facts.maxItems).toBe(ASSISTANT_LIMITS.briefRows);
    expect(p.facts.items?.required).toEqual(['label', 'value']);
    expect(p.briefReady.type).toBe('BOOLEAN');
  });

  it.each(LEGAL_MATTER_VALUES)(
    'offers answers only for the questions the model may answer, with their own option values (%s)',
    (matter) => {
      const answers = (buildTurnSchema(matter) as Schema).properties!.answers;
      const allowed = questionsForModel(matter);
      expect(Object.keys(answers.properties ?? {}).sort()).toEqual(
        allowed.map((q) => q.id).sort(),
      );
      for (const q of allowed) {
        const node = answers.properties![q.id];
        const values = q.options?.map((o) => o.value);
        if (q.kind === 'single') {
          expect(node).toEqual({ type: 'STRING', enum: values });
        } else if (q.kind === 'multi') {
          expect(node).toEqual({
            type: 'ARRAY',
            items: { type: 'STRING', enum: values },
          });
        } else {
          expect(node).toEqual({ type: 'STRING' });
        }
      }
      // Never the gender question or a documents question.
      const everything = questionsForMatter(matter);
      const left = everything.filter((q) => !allowed.includes(q));
      expect(left.length).toBeGreaterThan(0);
      for (const q of left) expect(answers.properties).not.toHaveProperty(q.id);
    },
  );

  it('is read by parseTurn and validAnswers as the reply it describes', () => {
    const matter = 'property';
    const single = questionsForModel(matter).find(
      (q) => q.kind === 'single' && (q.options?.length ?? 0) > 0,
    )!;
    const value = single.options![0].value;
    const turn = parseTurn(
      JSON.stringify({
        reply: 'Is the lease signed?',
        quickReplies: ['Yes', 'No'],
        matter: null,
        headline: null,
        facts: [{ label: 'Problem', value: 'Rent rise' }],
        answers: { [single.id]: value },
        briefReady: false,
      }),
    );
    expect(turn.matter).toBeNull();
    expect(turn.quickReplies).toEqual(['Yes', 'No']);
    expect(validAnswers(matter, turn.answers)).toEqual({ [single.id]: value });
  });
});

describe('LegalAssistantService profiling turn (FIX-22)', () => {
  class StandInGemini implements GeminiClient {
    chats: GeminiChatRequest[] = [];
    answers: string[] = [];
    chat(req: GeminiChatRequest): Promise<string> {
      this.chats.push(req);
      return Promise.resolve(this.answers.shift() ?? '');
    }
    generateBrief(): Promise<GeminiBrief> {
      return Promise.reject(new Error('not used by a profiling turn'));
    }
  }

  function build(matter: string) {
    const gemini = new StandInGemini();
    const created: Array<{ data: { body: string; authorRole: string } }> = [];
    const updated: Array<{
      data: { matter: string; answers: Record<string, unknown> };
    }> = [];
    const tx = {
      legalIntakeMessage: {
        findFirst: () => Promise.resolve({ id: 'm1' }),
        create: (arg: (typeof created)[number]) => {
          created.push(arg);
          return Promise.resolve({});
        },
      },
      legalIntake: {
        findUnique: () =>
          Promise.resolve({ status: 'in_progress', legalRequestId: null }),
        update: (arg: (typeof updated)[number]) => {
          updated.push(arg);
          return Promise.resolve({});
        },
      },
    };
    const prisma = {
      legalIntakeMessage: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'm1',
            authorRole: 'client',
            scripted: false,
            body: 'My landlord raised the rent by 60%',
            quickReplies: null,
            createdAt: new Date('2026-10-16T10:00:00Z'),
          },
        ]),
      },
      $transaction: jest.fn((fn: (t: typeof tx) => Promise<void>) => fn(tx)),
    };
    const allowance = { lockPerson: jest.fn().mockResolvedValue(undefined) };
    const service = new LegalAssistantService(
      prisma as never,
      gemini,
      {} as never,
      allowance as never,
      {} as never,
    );
    const intake = {
      id: 'i1',
      wawuUserId: 'u1',
      matter,
      status: 'in_progress',
      answers: {},
      brief: null,
      draftBrief: null,
      channel: 'assistant',
      legalRequestId: null,
    };
    const turn = () =>
      (
        service as unknown as { turn: (i: typeof intake) => Promise<void> }
      ).turn(intake);
    return { gemini, created, updated, turn };
  }

  it('sends the schema of the conversation matter with the instruction and history', async () => {
    const { gemini, turn } = build('property');
    gemini.answers.push(
      JSON.stringify({
        reply: 'Is the lease signed?',
        quickReplies: [],
        matter: null,
        headline: null,
        facts: [],
        answers: {},
        briefReady: false,
      }),
    );
    await turn();
    expect(gemini.chats).toHaveLength(1);
    expect(gemini.chats[0].responseSchema).toEqual(buildTurnSchema('property'));
    expect(gemini.chats[0].history).toEqual([
      { role: 'user', text: 'My landlord raised the rent by 60%' },
    ]);
    expect(gemini.chats[0].instruction).toContain('ONE JSON object');
  });

  it('stores the reply and answers it reads from a reply in that shape', async () => {
    const { gemini, created, updated, turn } = build('property');
    const single = questionsForModel('property').find(
      (q) => q.kind === 'single' && (q.options?.length ?? 0) > 0,
    )!;
    gemini.answers.push(
      JSON.stringify({
        reply: 'Thanks. Is the lease signed?',
        quickReplies: ['Yes', 'No'],
        matter: 'property',
        headline: 'Tenancy · rent increase',
        facts: [{ label: 'Problem', value: 'Rent up 60%' }],
        answers: { [single.id]: single.options![0].value },
        briefReady: false,
      }),
    );
    await turn();
    expect(created).toHaveLength(1);
    expect(created[0].data.authorRole).toBe('assistant');
    expect(created[0].data.body).toBe('Thanks. Is the lease signed?');
    expect(updated).toHaveLength(1);
    expect(updated[0].data.matter).toBe('property');
    expect(updated[0].data.answers).toEqual({
      [single.id]: single.options![0].value,
    });
  });
});
