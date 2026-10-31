// Contract tests for AITOOLS-06 (R-109): the Receptionist, a creator's own talking AI agent. Real HTTP against the caller's
// DATABASE_URL, the real job, input, points and Receptionist services and the real HTTP voice adapter against the voice
// stand-in on this machine (scripts/dev/voice-standin.cjs), including its agent socket. NOT RUN against the real provider
// (the owner's credits are not bought yet): the one proof run is written in tasks/AITOOLS-06.md. No payment provider.

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { randomUUID } from 'node:crypto';
import { AdminRole } from '../../../generated/prisma/enums';
import type { AdminActor } from '../../common/audit/admin-ops-audit.service';
import { PlanSettingsService } from '../../plan-settings/plan-settings.service';
import { loadPlansConfig } from '../../plans/plans-config';
import { AiToolsPurgeService } from '../ai-tools-purge.service';
import { ProviderCopyService } from '../voice/provider-copy.service';
import { ReceptionistController } from '../receptionist/receptionist.controller';
import type { AiJobView, AiToolsView } from '../ai-tools-view.type';
import type {
  ReceptionistRemovedView,
  ReceptionistView,
  VoiceSessionView,
} from '../receptionist/receptionist-view.type';
import {
  bootAiTools,
  type AiHarness,
  BASIC,
  PLAIN,
  PRO,
} from '../../../test/ai-tools/ai-tools-harness';
import { FILE_KINDS } from '../../account-purge/purge-files';
import { ACCOUNT_DATA_MAP } from '../../account-purge/account-data-map';
import {
  PointsHoldSweepService,
  RECEPTIONIST_VOICE_GRACE_MINUTES,
} from '../../points/spend/points-hold-sweep.service';

jest.setTimeout(180_000);

const plan = loadPlansConfig();
const cost = (id: string) => plan.actions.find((a) => a.id === id)!.points;
const MESSAGE = cost('receptionist_message');
const VOICE = cost('receptionist_voice_per_min');
const MAX_MIN = 5;
const admin: AdminActor = {
  id: randomUUID(),
  email: 'aitools06@admin.test.wawu.dev',
  role: AdminRole.finance,
};
const LONG_DASH = /[–—]/;
const data = <T>(res: { body: unknown }): T => (res.body as { data: T }).data;
const reasonOf = (res: { body: unknown }) =>
  (res.body as { reason: { code: string; message: string } }).reason;

describe('AITOOLS-06: the Receptionist (contract)', () => {
  let h: AiHarness;
  let settings: PlanSettingsService;
  const touched = new Set<string>();

  const set = async (key: string, value: number | string[] | null) => {
    touched.add(key);
    await settings.set(admin, { settings: { [key]: value } });
  };
  const auth = (who: string) => ({
    Authorization: `Bearer ${h.tokensOf[who]}`,
  });
  const token = (who: string, action: string, points: number) =>
    h.tokens.issue(
      who,
      action,
      points,
      new Date(Date.now() + (300 - h.tokens.seconds) * 1000),
    );
  const standin = () => h.standin.state;
  const mine = async (who: string) =>
    data<ReceptionistView>(
      await h.http().get('/ai-tools/receptionist').set(auth(who)),
    );
  const setUp = (who: string, body: Record<string, unknown> = {}) =>
    h
      .http()
      .put('/ai-tools/receptionist')
      .set(auth(who))
      .send({
        businessName: 'Ada Braids',
        offer: 'Knotless braids, twists and a weekend home service in Lekki.',
        replyStyle: 'Warm and short.',
        ...body,
      });
  const know = (who: string, body: Record<string, unknown>) =>
    h.http().post('/ai-tools/receptionist/knowledge').set(auth(who)).send(body);
  const say = (
    who: string,
    message: string,
    key: string | null = randomUUID(),
  ) => {
    const req = h.http().post('/ai-tools/receptionist/messages').set(auth(who));
    if (key !== null) req.set('Idempotency-Key', key);
    return req.send({
      message,
      quoteToken: token(who, 'receptionist_message', MESSAGE),
    });
  };
  const talk = (who: string, key: string | null = randomUUID()) => {
    const req = h
      .http()
      .post('/ai-tools/receptionist/voice-sessions')
      .set(auth(who));
    if (key !== null) req.set('Idempotency-Key', key);
    return req.send({
      quoteToken: token(who, 'receptionist_voice_per_min', VOICE * MAX_MIN),
    });
  };
  const end = (who: string, id: string) =>
    h
      .http()
      .post(`/ai-tools/receptionist/voice-sessions/${id}/end`)
      .set(auth(who));
  const readJob = async (who: string, id: string) =>
    data<AiJobView>(await h.http().get(`/ai-tools/jobs/${id}`).set(auth(who)));
  const textOf = (job: AiJobView) =>
    job.outputs.find((o) => o.kind === 'text')?.text ?? '';
  const stood = () => ({
    agents: h.standin.openAgents(),
    docs: h.standin.openKnowledge(),
  });

  beforeAll(async () => {
    h = await bootAiTools({ media: true, studio3: true, listen: true });
    settings = h.get<PlanSettingsService>(PlanSettingsService);
  });
  afterAll(async () => {
    for (const key of touched)
      await settings.set(admin, { settings: { [key]: null } });
    await h.prisma.adminOpsAudit.deleteMany({
      where: { actedByAdminId: admin.id },
    });
    await h.clean();
    await h.close();
  });
  beforeEach(async () => {
    await h.jobs.drain();
    await h.clean();
    const s = standin();
    for (const list of [
      s.agents,
      s.agentPatches,
      s.deletedAgents,
      s.knowledge,
      s.deletedKnowledge,
      s.chats,
      s.deletedConversations,
    ] as unknown[][])
      list.length = 0;
    s.signedUrls = 0;
    s.conversationDeleteRefusals = 0;
    h.inputs.files.clear();
    h.inputs.removed.length = 0;
    for (const key of [...touched]) await set(key, null);
    touched.clear();
    await set('ai.listed.receptionist', 1);
    await set('points.daily_cap', 100_000);
    await h.grant(PLAIN, 20_000);
    await h.grant(BASIC, 20_000);
  });
  afterEach(async () => {
    // Whatever a test left at the stand-in is removed with the person's Receptionist.
    for (const who of [PLAIN, BASIC, PRO]) await h.receptionist.clear(who);
  });

  describe('the listing switch and the catalogue', () => {
    it('lists nothing while the switch is off, draws nothing, refuses with nothing held, and lists the tool whole when on', async () => {
      await set('ai.listed.receptionist', 0);
      const off = data<AiToolsView>(
        await h.http().get('/ai-tools').set(auth(PLAIN)),
      );
      expect(off.tools.map((t) => t.id)).not.toContain('receptionist');
      expect((await mine(PLAIN)).available).toBe(false);
      const before = await h.balance(PLAIN);
      const saved = await setUp(PLAIN);
      expect(saved.status).toBe(503);
      expect(stood()).toEqual({ agents: 0, docs: 0 });
      expect((await say(PLAIN, 'Hello')).status).toBe(503);
      expect((await talk(PLAIN)).status).toBe(503);
      expect(await h.balance(PLAIN)).toBe(before);

      await set('ai.listed.receptionist', 1);
      const on = data<AiToolsView>(
        await h.http().get('/ai-tools').set(auth(PLAIN)),
      );
      const tool = on.tools.find((t) => t.id === 'receptionist')!;
      expect(tool).toMatchObject({
        action: 'receptionist_message',
        unit: 'message',
        costPointsPerUnit: MESSAGE,
        enabled: true,
        input: { kind: 'chat', maxCharacters: 1000 },
      });
      expect(`${tool.name} ${tool.description}`).not.toMatch(LONG_DASH);
      expect((await mine(PLAIN)).available).toBe(true);
    });

    it('names no phone, messaging channel or call list anywhere a person or a route can see it', async () => {
      await setUp(PLAIN);
      const text = JSON.stringify([
        await mine(PLAIN),
        data<AiToolsView>(await h.http().get('/ai-tools').set(auth(PLAIN))),
      ]);
      expect(text).not.toMatch(/whatsapp|phone|call list|batch|sip|twilio/i);
      const routes = Object.getOwnPropertyNames(
        ReceptionistController.prototype,
      );
      expect(routes.join(' ')).not.toMatch(/whatsapp|phone|call|batch|sip/i);
      const tables = await h.prisma.$queryRaw<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'Receptionist%'`;
      expect(tables.map((t) => t.table_name).sort()).toEqual([
        'ReceptionistAgent',
        'ReceptionistKnowledge',
        'ReceptionistTurn',
      ]);
    });
  });

  describe('setting it up and what it knows', () => {
    it("makes the agent on the first save with the Hub's guardrail, text-only chat allowed and a cheap model, and edits it on the next", async () => {
      const first = await setUp(PLAIN);
      expect(first.status).toBe(200);
      const view = data<ReceptionistView>(first);
      expect(view).toMatchObject({
        available: true,
        setUp: true,
        details: { businessName: 'Ada Braids', language: 'en' },
      });
      expect(view.limits).toMatchObject({
        docsMax: 10,
        voiceMaxMinutes: 5,
        messageMaxChars: 1000,
        languages: [{ code: 'en', name: 'English' }],
      });
      expect(standin().agents).toHaveLength(1);
      expect(standin().agents[0]).toMatchObject({
        llm: 'gemini-2.5-flash-lite',
        language: 'en',
        textOnlyOverride: true,
        promptHasGuardrail: true,
      });
      expect(standin().agents[0].firstMessage).toContain('Ada Braids');
      const again = await setUp(PLAIN, { offer: 'Now also lashes.' });
      expect(data<ReceptionistView>(again).details!.offer).toBe(
        'Now also lashes.',
      );
      expect(standin().agents).toHaveLength(1);
      expect(standin().agentPatches).toHaveLength(1);
      // Another person's Receptionist is their own.
      expect((await mine(BASIC)).setUp).toBe(false);
    });

    it('refuses an empty name, an empty offer, a language and a voice off the lists, each with nothing created', async () => {
      for (const bad of [{ businessName: '   ' }, { offer: ' ' }]) {
        const res = await setUp(PLAIN, bad);
        expect([400, 422]).toContain(res.status);
      }
      const lang = await setUp(PLAIN, { language: 'zz' });
      expect(reasonOf(lang).code).toBe('ai_language_unsupported');
      expect(reasonOf(await setUp(PLAIN, { voiceId: 'nobody' })).code).toBe(
        'ai_voice_unknown',
      );
      expect(stood()).toEqual({ agents: 0, docs: 0 });
      expect(
        (await setUp(PLAIN, { businessName: 'Bad [[reject]]' })).status,
      ).toBe(503);
      expect(stood().agents).toBe(0);
      expect((await mine(PLAIN)).setUp).toBe(false);
    });

    it('adds a text, a link and a document: the agent holds the three, and a document is read once and deleted from the Hub', async () => {
      await setUp(PLAIN);
      const t = await know(PLAIN, {
        kind: 'text',
        name: 'Prices',
        text: 'Knotless braids are 25,000 naira.',
      });
      expect(t.status).toBe(201);
      const u = await know(PLAIN, {
        kind: 'url',
        name: 'My page',
        url: 'https://example.com/ada',
      });
      expect(u.status).toBe(201);
      const fileKey = h.inputs.add(
        PLAIN,
        Buffer.from('Opening hours: 9 to 5.'),
        'text/plain',
        'ai/input-doc',
      );
      const f = await know(PLAIN, { kind: 'file', name: 'Hours', fileKey });
      expect(f.status).toBe(201);
      const view = data<ReceptionistView>(f);
      expect(view.knowledge.map((k) => [k.kind, k.name])).toEqual([
        ['text', 'Prices'],
        ['url', 'My page'],
        ['file', 'Hours'],
      ]);
      expect(standin().knowledge.map((k) => k.kind)).toEqual([
        'text',
        'url',
        'file',
      ]);
      expect(h.standin.openKnowledge()).toBe(3);
      const last = standin().agentPatches[standin().agentPatches.length - 1];
      expect(last.knowledge).toHaveLength(3);
      expect(h.standin.agent(standin().agents[0].id)!.knowledge).toHaveLength(
        3,
      );
      expect(h.inputs.removed).toContain(fileKey);
    });

    it("refuses over the limits, a link that is not https, a file type off the list, a document that is not what it says and another person's file, each with the reason and nothing created", async () => {
      await setUp(PLAIN);
      await set('ai.receptionist_text_max_chars', 100);
      const long = await know(PLAIN, {
        kind: 'text',
        name: 'Long',
        text: 'x'.repeat(200),
      });
      expect(long.status).toBe(422);
      expect(reasonOf(long).code).toBe('ai_prompt_too_long');
      const http = await know(PLAIN, {
        kind: 'url',
        name: 'Plain',
        url: 'http://example.com/ada',
      });
      expect(reasonOf(http).code).toBe('ai_link_invalid');
      await set('ai.receptionist_doc_max_bytes', 1024);
      const big = h.inputs.add(
        PLAIN,
        Buffer.alloc(4096, 97),
        'text/plain',
        'ai/input-doc',
      );
      expect(
        reasonOf(await know(PLAIN, { kind: 'file', name: 'Big', fileKey: big }))
          .code,
      ).toBe('ai_file_too_large');
      const wrong = h.inputs.add(
        PLAIN,
        Buffer.from('RIFF....WAVE'),
        'audio/wav',
        'ai/input-doc',
      );
      expect(
        reasonOf(
          await know(PLAIN, { kind: 'file', name: 'Wav', fileKey: wrong }),
        ).code,
      ).toBe('ai_file_type_unsupported');
      const fake = h.inputs.add(
        PLAIN,
        Buffer.from('this is not a pdf'),
        'application/pdf',
        'ai/input-doc',
      );
      expect(
        reasonOf(
          await know(PLAIN, { kind: 'file', name: 'Fake', fileKey: fake }),
        ).code,
      ).toBe('ai_file_unreadable');
      const theirs = h.inputs.add(
        BASIC,
        Buffer.from('hello'),
        'text/plain',
        'ai/input-doc',
      );
      expect(
        (await know(PLAIN, { kind: 'file', name: 'Theirs', fileKey: theirs }))
          .status,
      ).toBe(404);
      const noRoom = h.inputs.add(
        PLAIN,
        Buffer.from('hello'),
        'text/plain',
        'ai/input-audio',
      );
      expect(
        (
          await know(PLAIN, {
            kind: 'file',
            name: 'Audio folder',
            fileKey: noRoom,
          })
        ).status,
      ).toBe(404);
      expect(
        (await know(PLAIN, { kind: 'text', name: 'Empty', text: '  ' })).status,
      ).toBe(400);
      expect(
        (
          await know(BASIC, {
            kind: 'text',
            name: 'Before set up',
            text: 'Hello',
          })
        ).status,
      ).toBe(409);
      expect(standin().knowledge).toHaveLength(0);
      expect(h.standin.openKnowledge()).toBe(0);
      // The provider refusing a document leaves nothing either, and the place it took is free again.
      expect(
        (
          await know(PLAIN, {
            kind: 'text',
            name: 'Odd [[reject]]',
            text: 'Fine words.',
          })
        ).status,
      ).toBe(503);
      expect(
        await h.prisma.receptionistKnowledge.count({
          where: { wawuUserId: PLAIN },
        }),
      ).toBe(0);
    });

    it('holds the most things it may know, even when two are added at once', async () => {
      await setUp(PLAIN);
      await set('ai.receptionist_docs_max', 2);
      const out = await Promise.all(
        [1, 2, 3].map((i) =>
          know(PLAIN, { kind: 'text', name: `T${i}`, text: `Words ${i}` }),
        ),
      );
      expect(out.map((r) => r.status).sort()).toEqual([201, 201, 409]);
      expect(
        out.find((r) => r.status === 409) &&
          reasonOf(out.find((r) => r.status === 409)!).code,
      ).toBe('receptionist_knowledge_full');
      expect(h.standin.openKnowledge()).toBe(2);
    });

    it('forgets one thing (deleted at the provider and from the agent), and clearing deletes the agent and every document', async () => {
      await setUp(PLAIN);
      const a = data<ReceptionistView>(
        await know(PLAIN, { kind: 'text', name: 'A', text: 'One.' }),
      );
      await know(PLAIN, { kind: 'text', name: 'B', text: 'Two.' });
      const gone = await h
        .http()
        .delete(`/ai-tools/receptionist/knowledge/${a.knowledge[0].id}`)
        .set(auth(PLAIN));
      expect(gone.status).toBe(200);
      expect(data<ReceptionistView>(gone).knowledge.map((k) => k.name)).toEqual(
        ['B'],
      );
      expect(standin().deletedKnowledge).toHaveLength(1);
      expect(h.standin.agent(standin().agents[0].id)!.knowledge).toHaveLength(
        1,
      );
      // Another person cannot remove it, and a removed one is not there.
      await setUp(BASIC);
      const b = (await mine(PLAIN)).knowledge[0];
      expect(
        (
          await h
            .http()
            .delete(`/ai-tools/receptionist/knowledge/${b.id}`)
            .set(auth(BASIC))
        ).status,
      ).toBe(404);
      const cleared = await h
        .http()
        .delete('/ai-tools/receptionist')
        .set(auth(PLAIN));
      expect(data<ReceptionistRemovedView>(cleared)).toMatchObject({
        atProvider: 'gone',
        receptionist: { setUp: false, knowledge: [] },
      });
      expect(h.standin.openKnowledge()).toBe(0);
      expect(h.standin.openAgents()).toBe(1); // BASIC's own is untouched
      expect(
        await h.prisma.receptionistAgent.count({
          where: { wawuUserId: PLAIN },
        }),
      ).toBe(0);
    });

    it('deletes the agent, every document and every row when the account goes, and lists the tables in the data maps and the purge', async () => {
      await setUp(PLAIN);
      await know(PLAIN, { kind: 'text', name: 'A', text: 'One.' });
      await know(PLAIN, {
        kind: 'url',
        name: 'B',
        url: 'https://example.com/b',
      });
      await say(PLAIN, 'Hello');
      await h.jobs.drain();
      await h.get<AiToolsPurgeService>(AiToolsPurgeService).beforeErase(PLAIN);
      expect(stood()).toEqual({ agents: 0, docs: 0 });
      for (const model of [
        'ReceptionistAgent',
        'ReceptionistKnowledge',
        'ReceptionistTurn',
      ])
        expect(
          ACCOUNT_DATA_MAP.some(
            (r) => r.model === model && r.column === 'wawuUserId',
          ),
        ).toBe(true);
      expect(FILE_KINDS['ai/input-doc']?.decision).toBe('DELETE');
    });
  });

  describe('text messages', () => {
    it('holds the price, asks the agent text-only, keeps the points on the reply, and sends the earlier messages again', async () => {
      await setUp(PLAIN);
      await know(PLAIN, {
        kind: 'text',
        name: 'Prices',
        text: 'Knotless braids are 25,000 naira.',
      });
      await know(PLAIN, {
        kind: 'url',
        name: 'My page',
        url: 'https://example.com/ada',
      });
      await know(PLAIN, { kind: 'text', name: 'Hours', text: 'Open 9 to 5.' });
      const before = await h.balance(PLAIN);
      const res = await say(PLAIN, 'How much are braids?');
      expect(res.status).toBe(202);
      const started = data<AiJobView>(res);
      expect(started.state).toBe('working');
      expect(started.costPoints).toBe(MESSAGE);
      expect(await h.balance(PLAIN)).toBe(before - MESSAGE);
      const done = (await h.finish(PLAIN, started.id)) as unknown as AiJobView;
      expect(done.state).toBe('done');
      expect(textOf(done)).toMatch(/3 things: Prices, My page, Hours/);
      expect(await h.balance(PLAIN)).toBe(before - MESSAGE);
      expect(standin().chats[0]).toMatchObject({
        textOnly: true,
        earlier: false,
        keyLeak: false,
      });
      // The second message carries the first with it.
      const second = data<AiJobView>(await say(PLAIN, 'And the hours?'));
      await h.finish(PLAIN, second.id);
      expect(standin().chats[1]).toMatchObject({
        textOnly: true,
        earlier: true,
      });
      expect(await h.balance(PLAIN)).toBe(before - 2 * MESSAGE);
      await set('ai.receptionist_history_turns', 0);
      const third = data<AiJobView>(await say(PLAIN, 'Thanks'));
      await h.finish(PLAIN, third.id);
      expect(standin().chats[2].earlier).toBe(false);
    });

    it('answers a ping on the socket, gives every point back when the agent fails, and ends a message the provider never answers as failed', async () => {
      await setUp(PLAIN);
      const before = await h.balance(PLAIN);
      const ping = data<AiJobView>(await say(PLAIN, 'Hello [[ping]]'));
      expect((await h.finish(PLAIN, ping.id)).state).toBe('done');
      expect(standin().chats[0].pongs).toBe(1);
      const fail = data<AiJobView>(await say(PLAIN, 'Hello [[fail]]'));
      const ended = (await h.finish(PLAIN, fail.id)) as unknown as AiJobView;
      expect(ended.state).toBe('failed');
      expect(ended.message).toMatch(/No points were taken/);
      expect(ended.message).not.toMatch(LONG_DASH);
      expect(await h.balance(PLAIN)).toBe(before - MESSAGE);
    });

    it("refuses before the first save, an empty message and one over the limit, each with nothing held; another person's Receptionist is never used", async () => {
      const before = await h.balance(BASIC);
      const none = await say(BASIC, 'Hello');
      expect(none.status).toBe(409);
      expect(reasonOf(none).code).toBe('receptionist_not_set_up');
      await setUp(PLAIN);
      expect((await say(BASIC, 'Hello')).status).toBe(409);
      expect(reasonOf(await say(PLAIN, '   ')).code).toBe('ai_text_empty');
      await set('ai.receptionist_message_max_chars', 20);
      expect(reasonOf(await say(PLAIN, 'x'.repeat(30))).code).toBe(
        'ai_prompt_too_long',
      );
      expect(await h.balance(BASIC)).toBe(before);
      expect(standin().chats).toHaveLength(0);
    });

    it('sends one message for one Idempotency-Key, and holds the price of each of three messages sent at once', async () => {
      await setUp(PLAIN);
      const key = randomUUID();
      const before = await h.balance(PLAIN);
      const [a, b] = await Promise.all([
        say(PLAIN, 'Hello', key),
        say(PLAIN, 'Hello', key),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 202]);
      await h.finish(PLAIN, data<AiJobView>(a).id);
      expect(await h.balance(PLAIN)).toBe(before - MESSAGE);
      expect(standin().chats).toHaveLength(1);
      await setUp(BASIC);
      const have = await h.balance(BASIC);
      const rows = await Promise.all([1, 2, 3].map(() => say(BASIC, 'Hello')));
      expect(rows.every((r) => r.status === 202)).toBe(true);
      expect(await h.balance(BASIC)).toBe(have - 3 * MESSAGE);
      await Promise.all(
        rows.map((r) => h.finish(BASIC, data<AiJobView>(r).id)),
      );
      // With exactly one message's points, two sent at once take one and refuse the other: the balance never goes below zero.
      await setUp(PRO);
      await h.points.grant({
        wawuUserId: PRO,
        source: 'pack',
        sourceRef: randomUUID(),
        points: MESSAGE,
        expiresAt: new Date(Date.now() + 86_400_000),
      });
      const two = await Promise.all([
        say(PRO, 'Hello'),
        say(PRO, 'Hello again'),
      ]);
      expect(two.map((r) => r.status).sort()).toEqual([202, 402]);
      expect(await h.balance(PRO)).toBe(0);
      await h.finish(
        PRO,
        data<AiJobView>(two.find((r) => r.status === 202)!).id,
      );
      expect(await h.balance(PRO)).toBe(0);
    });
  });

  describe('talking', () => {
    it('holds the longest session, hands back a signed link and the conversation, keeps the real minutes on end and gives the rest back, once', async () => {
      await setUp(PLAIN);
      const before = await h.balance(PLAIN);
      const res = await talk(PLAIN);
      expect(res.status).toBe(201);
      const session = data<VoiceSessionView>(res);
      expect(session).toMatchObject({
        state: 'working',
        maxSeconds: MAX_MIN * 60,
        heldPoints: VOICE * MAX_MIN,
      });
      expect(session.signedUrl).toMatch(
        /^ws:\/\/127\.0\.0\.1:\d+\/__standin\/agent-socket\?/,
      );
      expect(session.conversationId).toMatch(/^convo-/);
      expect(await h.balance(PLAIN)).toBe(before - VOICE * MAX_MIN);
      // Not closed at the provider yet: the session stays open and the sweep settles it.
      const early = data<VoiceSessionView>(await end(PLAIN, session.id));
      expect(early.state).toBe('working');
      h.standin.setConversation(session.conversationId!, {
        status: 'done',
        seconds: 130,
      });
      expect(await h.receptionist.settleSessions()).toBe(1);
      const settled = await readJob(PLAIN, session.id);
      expect(settled.state).toBe('done');
      expect(await h.balance(PLAIN)).toBe(before - VOICE * 3);
      expect(settled.costPoints).toBe(VOICE * 3);
      // A second end changes nothing, and the provider keeps none of the talk.
      const again = data<VoiceSessionView>(await end(PLAIN, session.id));
      expect(again).toMatchObject({
        state: 'done',
        keptPoints: VOICE * 3,
        minutes: 3,
      });
      expect(await h.balance(PLAIN)).toBe(before - VOICE * 3);
      expect(standin().deletedConversations).toEqual([session.conversationId]);
    });

    it('keeps at most what was held when the talk was longer, settles at once when the provider already closed it, and gives everything back when it never ran', async () => {
      await setUp(PLAIN);
      const before = await h.balance(PLAIN);
      const long = data<VoiceSessionView>(await talk(PLAIN));
      h.standin.setConversation(long.conversationId!, {
        status: 'done',
        seconds: 9999,
      });
      expect(data<VoiceSessionView>(await end(PLAIN, long.id))).toMatchObject({
        state: 'done',
        minutes: MAX_MIN,
      });
      expect(await h.balance(PLAIN)).toBe(before - VOICE * MAX_MIN);
      const quick = data<VoiceSessionView>(await talk(PLAIN));
      h.standin.setConversation(quick.conversationId!, {
        status: 'done',
        seconds: 20,
      });
      expect(data<VoiceSessionView>(await end(PLAIN, quick.id))).toMatchObject({
        state: 'done',
        minutes: 1,
      });
      expect(await h.balance(PLAIN)).toBe(before - VOICE * MAX_MIN - VOICE);
      const failed = data<VoiceSessionView>(await talk(PLAIN));
      h.standin.setConversation(failed.conversationId!, {
        status: 'failed',
        seconds: null,
      });
      expect(data<VoiceSessionView>(await end(PLAIN, failed.id)).state).toBe(
        'failed',
      );
      expect(await h.balance(PLAIN)).toBe(before - VOICE * MAX_MIN - VOICE);
    });

    it('settles a session nobody ended at the longest, by the sweep, and one Idempotency-Key makes one session', async () => {
      await setUp(PLAIN);
      const before = await h.balance(PLAIN);
      const key = randomUUID();
      const first = await talk(PLAIN, key);
      const session = data<VoiceSessionView>(first);
      const replay = await talk(PLAIN, key);
      expect(replay.status).toBe(200);
      expect(data<VoiceSessionView>(replay)).toMatchObject({
        id: session.id,
        signedUrl: null,
      });
      expect(await h.balance(PLAIN)).toBe(before - VOICE * MAX_MIN);
      expect(await h.receptionist.settleSessions()).toBe(0);
      const late = new Date(
        Date.now() + (MAX_MIN + RECEPTIONIST_VOICE_GRACE_MINUTES + 1) * 60_000,
      );
      expect(await h.receptionist.settleSessions(late)).toBe(1);
      const job = await readJob(PLAIN, session.id);
      expect(job.state).toBe('done');
      expect(await h.balance(PLAIN)).toBe(before - VOICE * MAX_MIN);
    });

    it('ends a voice session the provider never closes, gives its points back, and frees the queue for newer sessions', async () => {
      await setUp(PLAIN);
      // One minute a session keeps each hold small, so a queue longer than a settle page can be made.
      await set('ai.receptionist_voice_max_minutes', 1);
      await h.grant(PLAIN, 20_000);
      const before = await h.balance(PLAIN);
      const talkOne = async () =>
        data<VoiceSessionView>(
          await h
            .http()
            .post('/ai-tools/receptionist/voice-sessions')
            .set(auth(PLAIN))
            .set('Idempotency-Key', randomUUID())
            .send({
              quoteToken: token(PLAIN, 'receptionist_voice_per_min', VOICE),
            }),
        );
      // Fifty-one talks the app ended but the provider never closed (the phone never connected): each stays open.
      const stuck: VoiceSessionView[] = [];
      for (let i = 0; i < 51; i += 1) {
        const session = await talkOne();
        h.standin.setConversation(session.conversationId!, {
          status: 'initiated',
          seconds: null,
        });
        expect(data<VoiceSessionView>(await end(PLAIN, session.id)).state).toBe(
          'working',
        );
        stuck.push(session);
      }
      // A newer talk the provider has closed: it is settled in the very next pass, not kept waiting behind the stuck ones.
      const newer = await talkOne();
      await end(PLAIN, newer.id);
      h.standin.setConversation(newer.conversationId!, {
        status: 'done',
        seconds: 30,
      });
      expect(await h.receptionist.settleSessions()).toBe(1);
      expect((await readJob(PLAIN, newer.id)).state).toBe('done');
      expect(await h.balance(PLAIN)).toBe(before - VOICE * 52);

      // Past the minutes the stale sweep uses, every stuck talk ends as a timed out failure and its points are back.
      const maxRun = settings.number('points.job_max_run_minutes');
      const late = new Date(Date.now() + (maxRun + 1) * 60_000);
      expect(await h.receptionist.settleSessions(late)).toBe(51);
      expect(await h.balance(PLAIN)).toBe(before - VOICE);
      const failed = await h.prisma.aiToolJob.findMany({
        where: { id: { in: stuck.map((x) => x.id) } },
        select: { state: true, failureCode: true },
      });
      expect(failed).toHaveLength(51);
      for (const row of failed)
        expect(row).toEqual({ state: 'failed', failureCode: 'timed_out' });
      const view = data<VoiceSessionView>(await end(PLAIN, stuck[0].id));
      expect(view).toMatchObject({
        state: 'failed',
        heldPoints: 0,
        keptPoints: 0,
      });
      // REC-DELETE: the provider never closed it, so a delete now would be accepted and ignored: none is sent. Once the
      // provider has finished it, the copy sweep deletes it and proves it gone.
      expect(standin().deletedConversations).not.toContain(
        stuck[0].conversationId,
      );
      h.standin.setConversation(stuck[0].conversationId!, { status: 'failed' });
      await h
        .get<ProviderCopyService>(ProviderCopyService)
        .sweep(new Date(Date.now() + 60_000));
      expect(standin().deletedConversations).toContain(stuck[0].conversationId);
      // A pass again changes nothing: no point is given back or taken twice.
      expect(await h.receptionist.settleSessions(late)).toBe(0);
      expect(await h.balance(PLAIN)).toBe(before - VOICE);

      // The stale sweep gave a hold back before the Hub looked at the row: the row ends as the points did, charging nothing.
      const swept = [await talkOne(), await talkOne()];
      for (const session of swept) {
        h.standin.setConversation(session.conversationId!, {
          status: 'initiated',
          seconds: null,
        });
        await end(PLAIN, session.id);
      }
      const sweep = new PointsHoldSweepService(h.spend, settings);
      const later = new Date(Date.now() + (maxRun + 2) * 60_000);
      await sweep.run(later);
      expect(
        await h.prisma.pointHold.count({
          where: { wawuUserId: PLAIN, state: 'held' },
        }),
      ).toBe(0);
      expect(await h.receptionist.settleSessions(later)).toBe(2);
      for (const session of swept)
        expect(
          await h.prisma.aiToolJob.findUnique({
            where: { id: session.id },
            select: { state: true, failureCode: true },
          }),
        ).toEqual({ state: 'failed', failureCode: 'timed_out' });
      // Only the closed talk was ever charged, once.
      expect(await h.balance(PLAIN)).toBe(before - VOICE);
      expect(
        await h.prisma.pointHold.count({
          where: { wawuUserId: PLAIN, state: 'committed' },
        }),
      ).toBe(1);
    });

    it("refuses before the first save, a stale quote and another person's session, with nothing held", async () => {
      const before = await h.balance(BASIC);
      expect(reasonOf(await talk(BASIC)).code).toBe('receptionist_not_set_up');
      await setUp(BASIC);
      const stale = await h
        .http()
        .post('/ai-tools/receptionist/voice-sessions')
        .set(auth(BASIC))
        .set('Idempotency-Key', randomUUID())
        .send({
          quoteToken: token(BASIC, 'receptionist_voice_per_min', VOICE),
        });
      expect(stale.status).toBe(409);
      expect(await h.balance(BASIC)).toBe(before);
      await setUp(PLAIN);
      const theirs = data<VoiceSessionView>(await talk(PLAIN));
      expect((await end(BASIC, theirs.id)).status).toBe(404);
    });
  });

  // REC-PRIVACY: the provider keeps an agent's conversations for ever unless it is told otherwise, so the Hub keeps
  // nothing at the provider longer than it must. Stand-in provider only; the same calls on the real one are NOT RUN.
  describe('what the provider keeps', () => {
    const PRIVACY = {
      record_voice: false,
      retention_days: 1,
      delete_audio: true,
      delete_transcript_and_pii: true,
    };
    const copies = () => h.get<ProviderCopyService>(ProviderCopyService);
    const ref = async (id: string) =>
      (
        await h.prisma.aiToolJob.findUnique({
          where: { id },
          select: { providerRef: true },
        })
      )?.providerRef ?? null;
    /** A minute past now: the copy sweep leaves a job alone for 30 seconds after it ended. */
    const later = () => new Date(Date.now() + 60_000);
    let delays: number[];
    beforeEach(() => {
      // Only the sweep tries again in these specs: no timers left running.
      delays = copies().delaysMs;
      copies().delaysMs = [];
    });
    afterEach(() => {
      copies().delaysMs = delays;
    });

    it('sends the privacy settings on every create and every update: no voice recording, one day, audio and words deleted, zero retention not asked for', async () => {
      await setUp(PLAIN);
      expect(standin().agents[0].privacy).toEqual(PRIVACY);
      expect(standin().agents[0].privacy).not.toHaveProperty(
        'zero_retention_mode',
      );
      await setUp(PLAIN, { offer: 'Knotless braids and twists.' });
      await know(PLAIN, { kind: 'text', name: 'A', text: 'One.' });
      const a = (await mine(PLAIN)).knowledge[0];
      await h
        .http()
        .delete(`/ai-tools/receptionist/knowledge/${a.id}`)
        .set(auth(PLAIN));
      // The edit, the add and the remove each update the agent: every one carries the settings.
      expect(standin().agentPatches.length).toBeGreaterThanOrEqual(3);
      for (const patch of standin().agentPatches)
        expect(patch.privacy).toEqual(PRIVACY);
    });

    it('deletes a text chat at the provider after the reply, and after a failed one, noting nothing on the row afterwards', async () => {
      await setUp(PLAIN);
      const open = h.standin.openConversations();
      const ok = data<AiJobView>(await say(PLAIN, 'Hello'));
      await h.finish(PLAIN, ok.id);
      await h.jobs.drain();
      expect(standin().deletedConversations).toHaveLength(1);
      expect(h.standin.openConversations()).toBe(open);
      expect(await ref(ok.id)).toBeNull();
      // The agent fails mid chat: the points go back and the chat the provider started is deleted too.
      const bad = data<AiJobView>(await say(PLAIN, 'Hello [[fail]]'));
      const failed = (await h.finish(PLAIN, bad.id)) as unknown as AiJobView;
      await h.jobs.drain();
      expect(failed.state).toBe('failed');
      expect(standin().deletedConversations).toHaveLength(2);
      expect(h.standin.openConversations()).toBe(open);
      expect(await ref(bad.id)).toBeNull();
    });

    it('keeps the note of a chat the provider would not delete and the existing sweep deletes it', async () => {
      await setUp(PLAIN);
      const open = h.standin.openConversations();
      standin().conversationDeleteRefusals = 1;
      const job = data<AiJobView>(await say(PLAIN, 'Hello'));
      await h.finish(PLAIN, job.id);
      await h.jobs.drain();
      expect(h.standin.openConversations()).toBe(open + 1);
      // REC-DELETE: the note says a delete was sent once the chat was finished (`@<ms>`); only a read after it clears it.
      expect(await ref(job.id)).toMatch(/^conversation:convo-\d+@\d+$/);
      expect(await copies().sweep(later())).toEqual({ cleared: 1, pending: 0 });
      expect(h.standin.openConversations()).toBe(open);
      expect(await ref(job.id)).toBeNull();
    });

    it('names the chat when only the socket does, and deletes it the same way', async () => {
      await setUp(PLAIN, { businessName: 'Ada Braids [[socket-id]]' });
      const open = h.standin.openConversations();
      const job = data<AiJobView>(await say(PLAIN, 'Hello'));
      await h.finish(PLAIN, job.id);
      await h.jobs.drain();
      expect(standin().deletedConversations).toHaveLength(1);
      expect(h.standin.openConversations()).toBe(open);
      expect(await ref(job.id)).toBeNull();
    });

    it('deletes a finished talk with the same retry: noted when the provider refuses, then swept', async () => {
      await setUp(PLAIN);
      const open = h.standin.openConversations();
      const session = data<VoiceSessionView>(await talk(PLAIN));
      h.standin.setConversation(session.conversationId!, {
        status: 'done',
        seconds: 61,
      });
      standin().conversationDeleteRefusals = 1;
      await end(PLAIN, session.id);
      expect((await readJob(PLAIN, session.id)).state).toBe('done');
      expect(h.standin.openConversations()).toBe(open + 1);
      expect(await ref(session.id)).toMatch(
        new RegExp(`^conversation:${session.conversationId}@\\d+$`),
      );
      expect(await copies().sweep(later())).toEqual({ cleared: 1, pending: 0 });
      expect(h.standin.openConversations()).toBe(open);
      expect(standin().deletedConversations).toEqual([session.conversationId]);
      expect(await ref(session.id)).toBeNull();
    });

    it('catches a finished talk whose conversation was never noted for deletion', async () => {
      await setUp(PLAIN);
      const open = h.standin.openConversations();
      const session = data<VoiceSessionView>(await talk(PLAIN));
      h.standin.setConversation(session.conversationId!, {
        status: 'done',
        seconds: 61,
      });
      standin().conversationDeleteRefusals = 1;
      await end(PLAIN, session.id);
      // The Hub stopped before the note was swapped: the row still holds the talk's own note.
      await h.prisma.aiToolJob.update({
        where: { id: session.id },
        data: { providerRef: `convo:${session.conversationId}` },
      });
      await h.receptionist.settleSessions();
      expect(h.standin.openConversations()).toBe(open);
      expect(await ref(session.id)).toBeNull();
    });

    it('clearing the Receptionist deletes every conversation still kept, and answers pending while one is left', async () => {
      await setUp(PLAIN);
      const open = h.standin.openConversations();
      standin().conversationDeleteRefusals = 1;
      const job = data<AiJobView>(await say(PLAIN, 'Hello'));
      await h.finish(PLAIN, job.id);
      await h.jobs.drain();
      expect(h.standin.openConversations()).toBe(open + 1);
      standin().conversationDeleteRefusals = 1;
      const first = await h
        .http()
        .delete('/ai-tools/receptionist')
        .set(auth(PLAIN));
      expect(data<ReceptionistRemovedView>(first).atProvider).toBe('pending');
      expect(h.standin.openConversations()).toBe(open + 1);
      const again = await h
        .http()
        .delete('/ai-tools/receptionist')
        .set(auth(PLAIN));
      expect(data<ReceptionistRemovedView>(again).atProvider).toBe('gone');
      expect(h.standin.openConversations()).toBe(open);
      expect(await ref(job.id)).toBeNull();
    });

    it('clearing the Receptionist during an open talk leaves the talk alone: the real minutes are kept when the app ends it, then its conversation is deleted', async () => {
      await setUp(PLAIN);
      const before = await h.balance(PLAIN);
      const open = h.standin.openConversations();
      const session = data<VoiceSessionView>(await talk(PLAIN));
      const first = await h
        .http()
        .delete('/ai-tools/receptionist')
        .set(auth(PLAIN));
      // The talk is still going: nothing of it is deleted, its note stays, and the answer is pending.
      expect(data<ReceptionistRemovedView>(first).atProvider).toBe('pending');
      expect(standin().deletedConversations).toEqual([]);
      expect(await ref(session.id)).toBe(`convo:${session.conversationId}`);
      // The app ends a 40 second talk: one minute is kept, as if nobody had cleared anything.
      h.standin.setConversation(session.conversationId!, {
        status: 'done',
        seconds: 40,
      });
      expect(
        data<VoiceSessionView>(await end(PLAIN, session.id)),
      ).toMatchObject({ state: 'done', minutes: 1, keptPoints: VOICE });
      expect(await h.balance(PLAIN)).toBe(before - VOICE);
      // Only now is the conversation deleted, and asking again finishes the clearing.
      expect(standin().deletedConversations).toEqual([session.conversationId]);
      expect(await ref(session.id)).toBeNull();
      const again = await h
        .http()
        .delete('/ai-tools/receptionist')
        .set(auth(PLAIN));
      expect(data<ReceptionistRemovedView>(again).atProvider).toBe('gone');
      expect(h.standin.openConversations()).toBe(open);
    });

    it('clearing the Receptionist after the app ended a talk the provider has not closed gives every point back, as before, and deletes the conversation after', async () => {
      await setUp(PLAIN);
      const before = await h.balance(PLAIN);
      const open = h.standin.openConversations();
      const session = data<VoiceSessionView>(await talk(PLAIN));
      h.standin.setConversation(session.conversationId!, {
        status: 'initiated',
        seconds: null,
      });
      expect(data<VoiceSessionView>(await end(PLAIN, session.id)).state).toBe(
        'working',
      );
      const first = await h
        .http()
        .delete('/ai-tools/receptionist')
        .set(auth(PLAIN));
      expect(data<ReceptionistRemovedView>(first).atProvider).toBe('pending');
      expect(standin().deletedConversations).toEqual([]);
      expect(await ref(session.id)).toBe(
        `convo:${session.conversationId}:ended`,
      );
      // The sweep, past its minutes, ends the talk as timed out with nothing charged and notes the conversation. The
      // provider has not closed it, so (REC-DELETE) no delete is sent yet: one now would be accepted and ignored.
      const maxRun = settings.number('points.job_max_run_minutes');
      const late = new Date(Date.now() + (maxRun + 1) * 60_000);
      expect(await h.receptionist.settleSessions(late)).toBe(1);
      expect(
        await h.prisma.aiToolJob.findUnique({
          where: { id: session.id },
          select: { state: true, failureCode: true },
        }),
      ).toEqual({ state: 'failed', failureCode: 'timed_out' });
      expect(await h.balance(PLAIN)).toBe(before);
      expect(standin().deletedConversations).toEqual([]);
      expect(await ref(session.id)).toBe(
        `conversation:${session.conversationId}`,
      );
      // Once the provider has finished it, clearing again deletes it, reads it back, and only then drops the note.
      h.standin.setConversation(session.conversationId!, { status: 'done' });
      const again = await h
        .http()
        .delete('/ai-tools/receptionist')
        .set(auth(PLAIN));
      expect(data<ReceptionistRemovedView>(again).atProvider).toBe('gone');
      expect(standin().deletedConversations).toEqual([session.conversationId]);
      expect(await ref(session.id)).toBeNull();
      expect(h.standin.openConversations()).toBe(open);
    });

    it('waits for an open talk when the account goes: the purge stops while it is open, then deletes its conversation once it has ended', async () => {
      await setUp(PLAIN);
      const before = await h.balance(PLAIN);
      const open = h.standin.openConversations();
      const session = data<VoiceSessionView>(await talk(PLAIN));
      const purge = h.get<AiToolsPurgeService>(AiToolsPurgeService);
      await expect(purge.beforeErase(PLAIN)).rejects.toThrow();
      expect(standin().deletedConversations).toEqual([]);
      expect(await ref(session.id)).toBe(`convo:${session.conversationId}`);
      h.standin.setConversation(session.conversationId!, {
        status: 'done',
        seconds: 40,
      });
      await end(PLAIN, session.id);
      expect(await h.balance(PLAIN)).toBe(before - VOICE);
      await purge.beforeErase(PLAIN);
      expect(h.standin.openConversations()).toBe(open);
      expect(stood()).toEqual({ agents: 0, docs: 0 });
    });

    it('deletes every conversation still kept when the account goes', async () => {
      await setUp(PLAIN);
      const open = h.standin.openConversations();
      standin().conversationDeleteRefusals = 1;
      const job = data<AiJobView>(await say(PLAIN, 'Hello'));
      await h.finish(PLAIN, job.id);
      await h.jobs.drain();
      expect(h.standin.openConversations()).toBe(open + 1);
      await h.get<AiToolsPurgeService>(AiToolsPurgeService).beforeErase(PLAIN);
      expect(h.standin.openConversations()).toBe(open);
      expect(stood()).toEqual({ agents: 0, docs: 0 });
    });
  });
});
