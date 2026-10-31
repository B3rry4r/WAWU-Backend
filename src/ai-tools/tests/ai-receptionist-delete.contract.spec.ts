// Contract tests for REC-DELETE: a Receptionist conversation is cleared from the Hub's notes only when the provider has
// proven it gone. Real HTTP against the caller's DATABASE_URL, the real job, points and Receptionist services and the real
// HTTP voice adapter against the voice stand-in (scripts/dev/voice-standin.cjs), which now answers a delete of an
// unfinished conversation 204 and ignores it, as the real provider did on 30 Oct 2026 (scratchpad proof, REC-PROOF.md and
// the REC-DELETE diagnostic). Scripted provider answers are used where the stand-in cannot make the case (a lost answer).
// No payment provider, no real provider.

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { AdminRole } from '../../../generated/prisma/enums';
import type { AdminActor } from '../../common/audit/admin-ops-audit.service';
import { PlanSettingsService } from '../../plan-settings/plan-settings.service';
import { loadPlansConfig } from '../../plans/plans-config';
import { AiToolsPurgeService } from '../ai-tools-purge.service';
import {
  CONVERSATION_GIVE_UP_MS,
  conversationDue,
  ProviderCopyService,
} from '../voice/provider-copy.service';
import {
  AiVoiceProviderError,
  type AiVoiceProvider,
} from '../voice/ai-voice-provider';
import { AI_VOICE_PROVIDER } from '../voice/ai-voice-provider';
import type { AiJobView } from '../ai-tools-view.type';
import type {
  ReceptionistRemovedView,
  VoiceSessionView,
} from '../receptionist/receptionist-view.type';
import {
  bootAiTools,
  type AiHarness,
  PLAIN,
} from '../../../test/ai-tools/ai-tools-harness';

jest.setTimeout(180_000);

const plan = loadPlansConfig();
const cost = (id: string) => plan.actions.find((a) => a.id === id)!.points;
const MESSAGE = cost('receptionist_message');
const VOICE = cost('receptionist_voice_per_min');
const MAX_MIN = 5;
const admin: AdminActor = {
  id: randomUUID(),
  email: 'recdelete@admin.test.wawu.dev',
  role: AdminRole.finance,
};
const data = <T>(res: { body: unknown }): T => (res.body as { data: T }).data;

describe('REC-DELETE: a conversation note is cleared only on proof (contract)', () => {
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
  const setUp = (who: string) =>
    h.http().put('/ai-tools/receptionist').set(auth(who)).send({
      businessName: 'Ada Braids',
      offer: 'Knotless braids, twists and a weekend home service in Lekki.',
    });
  const say = (who: string, message: string) =>
    h
      .http()
      .post('/ai-tools/receptionist/messages')
      .set(auth(who))
      .set('Idempotency-Key', randomUUID())
      .send({
        message,
        quoteToken: token(who, 'receptionist_message', MESSAGE),
      });
  const talk = (who: string) =>
    h
      .http()
      .post('/ai-tools/receptionist/voice-sessions')
      .set(auth(who))
      .set('Idempotency-Key', randomUUID())
      .send({
        quoteToken: token(who, 'receptionist_voice_per_min', VOICE * MAX_MIN),
      });
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
  /** The conversation the stand-in made last, while it still holds it (a chat or a talk). */
  const lastConversation = () => h.standin.conversationIds().at(-1)!;
  /** One text message, the job run to its end, and the conversation it made. */
  const chat = async (who = PLAIN) => {
    const job = data<AiJobView>(await say(who, 'Hello'));
    await h.finish(who, job.id);
    await h.jobs.drain();
    return { job, convo: lastConversation() };
  };
  /** A job row noting a conversation, for the scripted cases. */
  const noteRow = async (
    providerRef: string,
    when: { createdAt?: Date; finishedAt?: Date } = {},
  ) => {
    const finishedAt = when.finishedAt ?? new Date(Date.now() - 120_000);
    return h.prisma.aiToolJob.create({
      data: {
        wawuUserId: PLAIN,
        tool: 'receptionist_message',
        idempotencyKey: randomUUID(),
        requestHash: 'x',
        voiceId: '',
        characters: 1,
        units: 1,
        costPoints: 1,
        state: 'done',
        finishedAt,
        createdAt: when.createdAt ?? finishedAt,
        providerRef,
      },
    });
  };
  /** A provider that answers what a script says; nothing else of it is used by the copy service for a conversation. */
  const scripted = (reads: string[]) => {
    const calls: string[] = [];
    const queue = [...reads];
    const deletes: ('deleted' | 'failed' | 'not_found')[] = [];
    const service = () => {
      const made = new ProviderCopyService(h.prisma, voice, settings);
      // Only the sweep tries again: no timers left running.
      made.delaysMs = [];
      return made;
    };
    const voice = {
      readConversation: () => {
        calls.push('read');
        const next = queue.shift() ?? 'absent';
        if (next === 'absent')
          return Promise.reject(new AiVoiceProviderError('rejected', 'x', 404));
        if (next === 'unknown')
          return Promise.reject(new AiVoiceProviderError('unavailable', 'x'));
        return Promise.resolve({ status: next, seconds: 5 });
      },
      deleteConversation: () => {
        calls.push('delete');
        return Promise.resolve(deletes.shift() ?? 'deleted');
      },
    } as unknown as AiVoiceProvider;
    return {
      calls,
      deletes,
      service: service(),
    };
  };

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
  let delays: number[];
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
      s.ignoredConversationDeletes,
    ] as unknown[][])
      list.length = 0;
    s.signedUrls = 0;
    s.conversationDeleteRefusals = 0;
    s.chatConversationStatus = 'done';
    s.agentDeleteTakesConversations = false;
    h.inputs.files.clear();
    h.inputs.removed.length = 0;
    for (const key of [...touched]) await set(key, null);
    touched.clear();
    await set('ai.listed.receptionist', 1);
    await set('points.daily_cap', 100_000);
    await h.grant(PLAIN, 20_000);
    // Only the sweep tries again in these specs: no timers left running.
    delays = copies().delaysMs;
    copies().delaysMs = [];
  });
  afterEach(async () => {
    copies().delaysMs = delays;
    jest.restoreAllMocks();
    await h.receptionist.clear(PLAIN);
  });

  describe('the stand-in is the real provider in this', () => {
    it('answers a delete of an unfinished conversation 204 and ignores it: it reads 404 for a while, then comes back with its words', async () => {
      await setUp(PLAIN);
      const open = h.standin.openConversations();
      const voice = h.get<AiVoiceProvider>(AI_VOICE_PROVIDER);
      const link = await voice.openVoiceSession(
        (await h.prisma.receptionistAgent.findUnique({
          where: { wawuUserId: PLAIN },
        }))!.providerAgentId!,
      );
      const id = link.conversationId;
      expect(await voice.deleteConversation(id)).toBe('deleted');
      expect(standin().ignoredConversationDeletes).toEqual([id]);
      expect(h.standin.openConversations()).toBe(open + 1);
      await expect(voice.readConversation(id)).rejects.toMatchObject({
        status: 404,
      });
      h.standin.setConversation(id, { status: 'done', seconds: 3 });
      expect(await voice.readConversation(id)).toMatchObject({
        status: 'done',
      });
      expect(await voice.deleteConversation(id)).toBe('deleted');
      await expect(voice.readConversation(id)).rejects.toMatchObject({
        status: 404,
      });
      expect(h.standin.openConversations()).toBe(open);
    });
  });

  describe('a text chat', () => {
    it('is not deleted while the provider is still finishing it: the note stays, no delete is sent, and the sweep deletes it once it is done and reads it gone', async () => {
      await setUp(PLAIN);
      const open = h.standin.openConversations();
      standin().chatConversationStatus = 'processing';
      const { job, convo } = await chat();
      // The first try (at the end of the job) read it, saw it unfinished and sent nothing.
      expect(standin().deletedConversations).toEqual([]);
      expect(standin().ignoredConversationDeletes).toEqual([]);
      expect(h.standin.openConversations()).toBe(open + 1);
      expect(await ref(job.id)).toBe(`conversation:${convo}`);
      // Still unfinished a minute later: the sweep still sends nothing.
      expect(await copies().sweep(later())).toEqual({ cleared: 0, pending: 1 });
      expect(standin().ignoredConversationDeletes).toEqual([]);
      expect(await ref(job.id)).toBe(`conversation:${convo}`);
      // Done: deleted, read again, and only then is the note cleared.
      h.standin.setConversation(convo, { status: 'done', seconds: 2 });
      expect(await copies().sweep(later())).toEqual({ cleared: 1, pending: 0 });
      expect(standin().deletedConversations).toEqual([convo]);
      expect(h.standin.openConversations()).toBe(open);
      expect(await ref(job.id)).toBeNull();
    });

    it('does not clear the note on a 404 read that proves nothing: the provider may not have stored it yet', async () => {
      await setUp(PLAIN);
      const open = h.standin.openConversations();
      standin().chatConversationStatus = 'processing';
      const { job, convo } = await chat();
      h.standin.setConversation(convo, { hidden: true });
      // 404 and no delete was ever sent: a note this young stays, and so does an old one (nothing to prove it gone).
      expect(await copies().sweep(later())).toEqual({ cleared: 0, pending: 1 });
      expect(await ref(job.id)).toBe(`conversation:${convo}`);
      expect(standin().deletedConversations).toEqual([]);
      expect(standin().ignoredConversationDeletes).toEqual([]);
      // It appears finished: deleted and proven gone.
      h.standin.setConversation(convo, { status: 'done', hidden: false });
      expect(await copies().sweep(later())).toEqual({ cleared: 1, pending: 0 });
      expect(await ref(job.id)).toBeNull();
      expect(h.standin.openConversations()).toBe(open);
    });

    it('is deleted at the end of the job when the provider has already finished it, and the note is cleared by the read that says 404', async () => {
      await setUp(PLAIN);
      const open = h.standin.openConversations();
      const { job } = await chat();
      expect(standin().deletedConversations).toHaveLength(1);
      expect(h.standin.openConversations()).toBe(open);
      expect(await ref(job.id)).toBeNull();
    });

    it('charges once however often the conversation is tried', async () => {
      await setUp(PLAIN);
      const before = await h.balance(PLAIN);
      standin().chatConversationStatus = 'processing';
      const { convo } = await chat();
      expect(await h.balance(PLAIN)).toBe(before - MESSAGE);
      await copies().sweep(later());
      await copies().sweep(later());
      h.standin.setConversation(convo, { status: 'done' });
      await copies().sweep(later());
      await copies().sweep(later());
      expect(await h.balance(PLAIN)).toBe(before - MESSAGE);
      expect(
        await h.prisma.pointHold.count({
          where: { wawuUserId: PLAIN, state: 'committed' },
        }),
      ).toBe(1);
    });
  });

  describe('a voice talk', () => {
    it('is deleted once it has settled and the provider shows it done, and its note goes only when a read says 404', async () => {
      await setUp(PLAIN);
      const open = h.standin.openConversations();
      const before = await h.balance(PLAIN);
      const session = data<VoiceSessionView>(await talk(PLAIN));
      h.standin.setConversation(session.conversationId!, {
        status: 'done',
        seconds: 61,
      });
      await h
        .http()
        .post(`/ai-tools/receptionist/voice-sessions/${session.id}/end`)
        .set(auth(PLAIN));
      expect(standin().deletedConversations).toEqual([session.conversationId]);
      expect(h.standin.openConversations()).toBe(open);
      expect(await ref(session.id)).toBeNull();
      expect(await h.balance(PLAIN)).toBe(before - VOICE * 2);
    });
  });

  describe('clearing the Receptionist and deleting the account', () => {
    it('takes a conversation the provider has not finished with the agent: the note goes on the read that says 404', async () => {
      await setUp(PLAIN);
      const open = h.standin.openConversations();
      standin().chatConversationStatus = 'processing';
      standin().agentDeleteTakesConversations = true;
      const { job } = await chat();
      expect(await ref(job.id)).toMatch(/^conversation:convo-\d+$/);
      const res = await h
        .http()
        .delete('/ai-tools/receptionist')
        .set(auth(PLAIN));
      expect(data<ReceptionistRemovedView>(res).atProvider).toBe('gone');
      expect(standin().deletedAgents).toHaveLength(1);
      expect(h.standin.openConversations()).toBe(open);
      expect(await ref(job.id)).toBeNull();
    });

    it('answers pending while a conversation is still there and unfinished, and clears it once it is done and read gone', async () => {
      await setUp(PLAIN);
      const open = h.standin.openConversations();
      standin().chatConversationStatus = 'processing';
      const { job, convo } = await chat();
      const first = await h
        .http()
        .delete('/ai-tools/receptionist')
        .set(auth(PLAIN));
      expect(data<ReceptionistRemovedView>(first).atProvider).toBe('pending');
      expect(standin().ignoredConversationDeletes).toEqual([]);
      expect(await ref(job.id)).toBe(`conversation:${convo}`);
      h.standin.setConversation(convo, { status: 'done' });
      const again = await h
        .http()
        .delete('/ai-tools/receptionist')
        .set(auth(PLAIN));
      expect(data<ReceptionistRemovedView>(again).atProvider).toBe('gone');
      expect(standin().deletedConversations).toEqual([convo]);
      expect(await ref(job.id)).toBeNull();
      expect(h.standin.openConversations()).toBe(open);
    });

    it('lets the account purge go once the agent has taken an unfinished conversation with it', async () => {
      await setUp(PLAIN);
      const open = h.standin.openConversations();
      standin().chatConversationStatus = 'processing';
      standin().agentDeleteTakesConversations = true;
      const { job } = await chat();
      await h.get<AiToolsPurgeService>(AiToolsPurgeService).beforeErase(PLAIN);
      expect(h.standin.openConversations()).toBe(open);
      expect(h.standin.openAgents()).toBe(0);
      expect(await ref(job.id)).toBeNull();
    });
  });

  describe('the proof and the backoff, scripted', () => {
    it('sends a delete only after a read shows it finished, marks the note first, and clears it only on a read that says 404', async () => {
      const row = await noteRow('conversation:conv-1');
      const s = scripted(['done', 'absent']);
      await s.service.discard(row.id, { kind: 'conversation', id: 'conv-1' });
      expect(s.calls).toEqual(['read', 'delete', 'read']);
      expect(await ref(row.id)).toBeNull();
    });

    it('keeps the note when the delete is answered 204 but the conversation is still there, and clears it on a later read that says 404', async () => {
      const row = await noteRow('conversation:conv-2');
      const s = scripted(['done', 'done', 'absent']);
      await s.service.discard(row.id, { kind: 'conversation', id: 'conv-2' });
      expect(s.calls).toEqual(['read', 'delete', 'read']);
      expect(await ref(row.id)).toMatch(/^conversation:conv-2@\d+$/);
      // Later: it reads 404 and a delete was sent after it finished: gone.
      expect(await s.service.sweep(later())).toEqual({
        cleared: 1,
        pending: 0,
      });
      expect(s.calls).toEqual(['read', 'delete', 'read', 'read']);
      expect(await ref(row.id)).toBeNull();
    });

    it('counts a delete whose answer was lost: a later 404 clears the note', async () => {
      const row = await noteRow('conversation:conv-3');
      const s = scripted(['done', 'absent']);
      s.deletes.push('failed');
      await s.service.discard(row.id, { kind: 'conversation', id: 'conv-3' });
      expect(s.calls).toEqual(['read', 'delete']);
      expect(await ref(row.id)).toMatch(/^conversation:conv-3@\d+$/);
      expect(await s.service.sweep(later())).toEqual({
        cleared: 1,
        pending: 0,
      });
      expect(await ref(row.id)).toBeNull();
    });

    it('does not clear a note on a 404 when no delete was sent, and does nothing on an answer it cannot read', async () => {
      const row = await noteRow('conversation:conv-4');
      const s = scripted(['absent', 'unknown', 'in-progress', 'processing']);
      for (let i = 0; i < 4; i += 1)
        expect(await s.service.sweep(later())).toEqual({
          cleared: 0,
          pending: 1,
        });
      expect(s.calls).toEqual(['read', 'read', 'read', 'read']);
      expect(await ref(row.id)).toBe('conversation:conv-4');
    });

    it('treats failed like done', async () => {
      const row = await noteRow('conversation:conv-5');
      const s = scripted(['failed', 'absent']);
      expect(await s.service.sweep(later())).toEqual({
        cleared: 1,
        pending: 0,
      });
      expect(s.calls).toEqual(['read', 'delete', 'read']);
      expect(await ref(row.id)).toBeNull();
    });

    it('drops a note older than 25 hours with one warning and sends nothing to the provider', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const old = new Date(Date.now() - CONVERSATION_GIVE_UP_MS - 60_000);
      const row = await noteRow('conversation:conv-6', {
        createdAt: old,
        finishedAt: old,
      });
      const s = scripted(['done']);
      expect(await s.service.sweep(new Date())).toEqual({
        cleared: 1,
        pending: 0,
      });
      expect(s.calls).toEqual([]);
      expect(await ref(row.id)).toBeNull();
      const dropped = warn.mock.calls.filter((c) =>
        String(c[0]).includes('25 hours'),
      );
      expect(dropped).toHaveLength(1);
      expect(String(dropped[0][0])).not.toContain('conv-6');
      expect(String(dropped[0][0])).not.toMatch(/[–—]/);
    });

    it('still tries a note a little under 25 hours old, on the 30 minute schedule', async () => {
      const made = new Date(Date.now() - CONVERSATION_GIVE_UP_MS + 3_600_000);
      // 24 hours after it ended: 24 h is a multiple of 30 minutes, so a try is due now.
      const row = await noteRow('conversation:conv-7', {
        createdAt: made,
        finishedAt: made,
      });
      const s = scripted(['in-progress']);
      expect(
        await s.service.sweep(new Date(made.getTime() + 24 * 3_600_000)),
      ).toEqual({ cleared: 0, pending: 1 });
      expect(s.calls).toEqual(['read']);
      expect(await ref(row.id)).toBe('conversation:conv-7');
    });

    it('backs off: every minute for 5 minutes, every 5 minutes to the hour, every 30 minutes after', () => {
      const min = 60_000;
      expect(conversationDue(0)).toBe(true);
      expect(conversationDue(4 * min + 59_000)).toBe(true);
      expect(conversationDue(5 * min)).toBe(true);
      expect(conversationDue(6 * min)).toBe(true);
      expect(conversationDue(7 * min)).toBe(false);
      expect(conversationDue(9 * min)).toBe(false);
      expect(conversationDue(10 * min)).toBe(true);
      expect(conversationDue(59 * min)).toBe(false);
      expect(conversationDue(60 * min)).toBe(true);
      expect(conversationDue(61 * min)).toBe(true);
      expect(conversationDue(62 * min)).toBe(false);
      expect(conversationDue(90 * min)).toBe(true);
      expect(conversationDue(120 * min)).toBe(true);
      expect(conversationDue(125 * min)).toBe(false);
    });

    it('leaves a note that is not due alone: no read is made', async () => {
      const finished = new Date(Date.now() - 8 * 60_000);
      const row = await noteRow('conversation:conv-8', {
        finishedAt: finished,
      });
      const s = scripted(['done']);
      expect(await s.service.sweep(new Date())).toEqual({
        cleared: 0,
        pending: 1,
      });
      expect(s.calls).toEqual([]);
      expect(await ref(row.id)).toBe('conversation:conv-8');
    });
  });
});
