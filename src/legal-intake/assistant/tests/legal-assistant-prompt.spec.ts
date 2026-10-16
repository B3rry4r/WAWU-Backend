import {
  buildHistory,
  buildInstruction,
  parseTurn,
  questionsForModel,
  validAnswers,
  withoutEmDash,
} from '../legal-assistant-prompt';

/**
 * The profiling turn's pure parts (LEGAL-01): what the model is told, how
 * the conversation is shown to it, and how its answer is read back. No
 * provider, no database.
 */
describe('Legal assistant prompt (LEGAL-01)', () => {
  describe('buildHistory', () => {
    it('leaves out scripted lines, starts with the client and joins two client messages in a row', () => {
      const history = buildHistory(
        [
          {
            authorRole: 'assistant',
            scripted: true,
            body: 'Hi Chidi. Tell me.',
          },
          {
            authorRole: 'assistant',
            scripted: true,
            body: 'Nothing is charged.',
          },
          { authorRole: 'client', scripted: false, body: 'Rent went up' },
          { authorRole: 'client', scripted: false, body: 'by 60%' },
          {
            authorRole: 'assistant',
            scripted: false,
            body: 'Is the lease signed?',
          },
          { authorRole: 'client', scripted: false, body: 'Yes' },
        ],
        30,
      );
      expect(history).toEqual([
        { role: 'user', text: 'Rent went up\n\nby 60%' },
        { role: 'model', text: 'Is the lease signed?' },
        { role: 'user', text: 'Yes' },
      ]);
      expect(JSON.stringify(history)).not.toContain('Chidi');
    });

    it('keeps only the newest messages and never starts with the assistant', () => {
      const history = buildHistory(
        [
          { authorRole: 'client', scripted: false, body: 'one' },
          { authorRole: 'assistant', scripted: false, body: 'two' },
          { authorRole: 'client', scripted: false, body: 'three' },
        ],
        2,
      );
      expect(history).toEqual([{ role: 'user', text: 'three' }]);
    });
  });

  describe('buildInstruction', () => {
    it('lists the matters and this matter’s questions, never the gender question, and the brief so far', () => {
      const text = buildInstruction({
        matter: 'property',
        draft: {
          headline: 'Tenancy',
          facts: [{ label: 'Lease', value: 'Signed' }],
          ready: false,
        },
        answers: { property_role: 'tenant', gender: 'female' },
      });
      expect(text).toContain('- property: Property');
      expect(text).toContain(
        '- property_role: What is your position? (one of: buying, selling, leasing, landlord, tenant, inherited, dispute)',
      );
      expect(text).toContain('[{"label":"Lease","value":"Signed"}]');
      expect(text).toContain('{"property_role":"tenant"}');
      expect(text).not.toMatch(/gender/i);
      expect(text).not.toMatch(/—/);
      expect(
        questionsForModel('property').some((q) => q.kind === 'documents'),
      ).toBe(false);
    });
  });

  describe('parseTurn', () => {
    const base = {
      reply: 'Is the lease signed?',
      quickReplies: ['Yes', 'No', 'Yes', 'Not sure', 'Maybe', 'Other'],
      matter: 'property',
      headline: 'Tenancy — rent rise',
      facts: [
        { label: 'Matter', value: 'should be dropped' },
        { label: 'Lease', value: 'Signed' },
        { label: '', value: 'no label' },
        'not an object',
      ],
      answers: { property_role: 'tenant' },
      briefReady: true,
    };

    it('reads a plain or fenced object and cleans what a person will read', () => {
      for (const raw of [
        JSON.stringify(base),
        '```json\n' + JSON.stringify(base) + '\n```',
        'Here you go: ' + JSON.stringify(base),
      ]) {
        const turn = parseTurn(raw);
        expect(turn.reply).toBe('Is the lease signed?');
        expect(turn.quickReplies).toEqual(['Yes', 'No', 'Not sure', 'Maybe']);
        expect(turn.headline).toBe('Tenancy, rent rise');
        expect(turn.facts).toEqual([{ label: 'Lease', value: 'Signed' }]);
        expect(turn.matter).toBe('property');
        expect(turn.briefReady).toBe(true);
      }
    });

    it('drops a matter that is not one of the fourteen, and a briefReady that is not true', () => {
      const turn = parseTurn(
        JSON.stringify({ ...base, matter: 'divorce', briefReady: 'yes' }),
      );
      expect(turn.matter).toBeNull();
      expect(turn.briefReady).toBe(false);
    });

    it('cuts long text to size', () => {
      const turn = parseTurn(
        JSON.stringify({
          ...base,
          reply: 'a'.repeat(5000),
          quickReplies: ['b'.repeat(100)],
        }),
      );
      expect(turn.reply.length).toBe(1200);
      expect(turn.quickReplies[0].length).toBe(40);
    });

    it('throws on no JSON, broken JSON, an array or no reply', () => {
      for (const raw of [
        'plain words',
        '{"reply": ',
        '[1,2]',
        '{"reply": "  "}',
        '{}',
      ]) {
        expect(() => parseTurn(raw)).toThrow();
      }
    });
  });

  describe('validAnswers', () => {
    it('keeps known ids with their own option values only', () => {
      expect(
        validAnswers('property', {
          property_role: 'tenant',
          urgency: 'yesterday',
          gender: 'female',
          documents: ['https://x'],
          outcome: ['recover_money', 'not-an-option'],
          deadline_date: '2026-11-01',
          description: '  Rent — up 60%  ',
          made_up: 'x',
        }),
      ).toEqual({
        property_role: 'tenant',
        outcome: ['recover_money'],
        deadline_date: '2026-11-01',
        description: 'Rent, up 60%',
      });
    });

    it('withoutEmDash replaces every em-dash', () => {
      expect(withoutEmDash('a — b—c')).toBe('a, b, c');
    });
  });
});
