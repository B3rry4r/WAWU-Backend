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
  /**
   * A provider that answers what a script says; nothing else of it is used by the copy service for a conversation.
   * `reads` are the answers of GET by id (`absent` is a 404, `unknown` a fault), `lists` those of the provider's list
   * (`absent` is a complete list without the conversation, `unknown` a list that cannot be read, a status is a list that
   * holds it). An empty script answers `absent`.
   */
  const scripted = (
    id: string,
    reads: string[],
    lists: string[] = [],
    deleteMs = 0,
  ) => {
    const calls: string[] = [];
    const readQueue = [...reads];
    const listQueue = [...lists];
    const deletes: ('deleted' | 'failed' | 'not_found')[] = [];
    const voice = {
      readConversation: () => {
        calls.push('read');
        const next = readQueue.shift() ?? 'absent';
        if (next === 'absent')
          return Promise.reject(new AiVoiceProviderError('rejected', 'x', 404));
        if (next === 'unknown')
          return Promise.reject(new AiVoiceProviderError('unavailable', 'x'));
        return Promise.resolve({ status: next, seconds: 5 });
      },
      listConversations: () => {
        calls.push('list');
        const next = listQueue.shift() ?? 'absent';
        if (next === 'unknown')
          return Promise.reject(new AiVoiceProviderError('unavailable', 'x'));
        return Promise.resolve(
          next === 'absent' ? [] : [{ conversationId: id, status: next }],
        );
      },
      deleteConversation: async () => {
        calls.push('delete');
        if (deleteMs > 0) await new Promise((r) => setTimeout(r, deleteMs));
        return deletes.shift() ?? 'deleted';
      },
    } as unknown as AiVoiceProvider;
    const service = new ProviderCopyService(h.prisma, voice, settings);
    // Only the sweep tries again: no timers left running.
    service.delaysMs = [];
    return { calls, deletes, service };
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
      h.standin.setConversation(convo, { hidden: true, unlisted: true });
      // 404 by id, not in the list, and no delete was ever sent: the note stays (nothing proves it gone).
      expect(await copies().sweep(later())).toEqual({ cleared: 0, pending: 1 });
      expect(await ref(job.id)).toBe(`conversation:${convo}`);
      expect(standin().deletedConversations).toEqual([]);
      expect(standin().ignoredConversationDeletes).toEqual([]);
      // It appears finished: deleted and proven gone.
      h.standin.setConversation(convo, {
        status: 'done',
        hidden: false,
        unlisted: false,
      });
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
    it('is not cleared by a 404 after the agent delete when no delete was sent: pending, the note stays, and the 25 hour drop ends it', async () => {
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
      // The provider took the conversation with the agent, but a 404 by id is not proof and nothing was sent.
      expect(data<ReceptionistRemovedView>(res).atProvider).toBe('pending');
      expect(standin().deletedAgents).toHaveLength(1);
      expect(h.standin.openConversations()).toBe(open);
      expect(await ref(job.id)).toMatch(/^conversation:convo-\d+$/);
      expect(standin().conversationListReads).toBeGreaterThan(0);
      // The account purge waits for it as well.
      await expect(
        h.get<AiToolsPurgeService>(AiToolsPurgeService).beforeErase(PLAIN),
      ).rejects.toThrow();
      // Past the provider's own limit the note is dropped (one warning), and clearing again finishes.
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      expect(
        await copies().sweep(new Date(Date.now() + 25 * 3_600_000 + 60_000)),
      ).toEqual({ cleared: 1, pending: 0 });
      expect(
        warn.mock.calls.filter((c) => String(c[0]).includes('25 hours')),
      ).toHaveLength(1);
      expect(await ref(job.id)).toBeNull();
      const again = await h
        .http()
        .delete('/ai-tools/receptionist')
        .set(auth(PLAIN));
      expect(data<ReceptionistRemovedView>(again).atProvider).toBe('gone');
    });

    it('answers pending while a conversation is still there and unfinished, and clears it once it is done and read gone', async () => {
      await setUp(PLAIN);
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
      expect(h.standin.openConversations()).toBe(0);
    });

    describe('a conversation still being finished when its agent is deleted (race B on the real provider)', () => {
      it('is kept by the provider, 404 by id and still listed: the note stays pending, the sweep finds it in the list, deletes it by id once done, and clears it when the list no longer holds it', async () => {
        await setUp(PLAIN);
        const open = h.standin.openConversations();
        standin().chatConversationStatus = 'processing';
        standin().agentDeleteOrphansConversations = true;
        const { job, convo } = await chat();
        const res = await h
          .http()
          .delete('/ai-tools/receptionist')
          .set(auth(PLAIN));
        expect(data<ReceptionistRemovedView>(res).atProvider).toBe('pending');
        expect(standin().deletedAgents).toHaveLength(1);
        // The provider still holds it: 404 by id, listed, and no delete was sent (it is not finished).
        expect(h.standin.openConversations()).toBe(open + 1);
        expect(standin().deletedConversations).toEqual([]);
        expect(standin().ignoredConversationDeletes).toEqual([]);
        expect(await ref(job.id)).toBe(`conversation:${convo}`);
        // A minute on, still not finished: the sweep reads the list, sees it unfinished, and sends nothing.
        expect(await copies().sweep(later())).toEqual({
          cleared: 0,
          pending: 1,
        });
        expect(standin().ignoredConversationDeletes).toEqual([]);
        expect(await ref(job.id)).toBe(`conversation:${convo}`);
        // The provider finishes it: the sweep deletes it by id and clears the note only after the list lacks it.
        h.standin.setConversation(convo, { status: 'done' });
        expect(await copies().sweep(later())).toEqual({
          cleared: 1,
          pending: 0,
        });
        expect(standin().deletedConversations).toEqual([convo]);
        expect(h.standin.openConversations()).toBe(open);
        expect(await ref(job.id)).toBeNull();
        const again = await h
          .http()
          .delete('/ai-tools/receptionist')
          .set(auth(PLAIN));
        expect(data<ReceptionistRemovedView>(again).atProvider).toBe('gone');
      });

      it('is deleted by id at once when it is already done, and the answer is gone', async () => {
        await setUp(PLAIN);
        const open = h.standin.openConversations();
        standin().chatConversationStatus = 'processing';
        standin().agentDeleteOrphansConversations = true;
        const { job, convo } = await chat();
        h.standin.setConversation(convo, { status: 'done' });
        const res = await h
          .http()
          .delete('/ai-tools/receptionist')
          .set(auth(PLAIN));
        expect(data<ReceptionistRemovedView>(res).atProvider).toBe('gone');
        expect(standin().deletedConversations).toEqual([convo]);
        expect(h.standin.openConversations()).toBe(open);
        expect(await ref(job.id)).toBeNull();
      });

      it('holds the account purge until it is finished, deleted and gone from the list', async () => {
        await setUp(PLAIN);
        const open = h.standin.openConversations();
        standin().chatConversationStatus = 'processing';
        standin().agentDeleteOrphansConversations = true;
        const { job, convo } = await chat();
        const purge = h.get<AiToolsPurgeService>(AiToolsPurgeService);
        await expect(purge.beforeErase(PLAIN)).rejects.toThrow();
        expect(h.standin.openConversations()).toBe(open + 1);
        h.standin.setConversation(convo, { status: 'done' });
        await copies().sweep(later());
        expect(await ref(job.id)).toBeNull();
        await purge.beforeErase(PLAIN);
        expect(h.standin.openConversations()).toBe(open);
        expect(h.standin.openAgents()).toBe(0);
      });
    });

    it('ignores a note older than 25 hours: it neither holds DELETE /receptionist nor the account purge', async () => {
      await setUp(PLAIN);
      const old = new Date(Date.now() - 26 * 3_600_000);
      await noteRow('conversation:conv-old', {
        createdAt: old,
        finishedAt: old,
      });
      const res = await h
        .http()
        .delete('/ai-tools/receptionist')
        .set(auth(PLAIN));
      expect(data<ReceptionistRemovedView>(res).atProvider).toBe('gone');
      await setUp(PLAIN);
      await h.get<AiToolsPurgeService>(AiToolsPurgeService).beforeErase(PLAIN);
    });
  });

  describe('POST /end', () => {
    it('does not wait for the provider to delete the talk: it answers within a moment and the delete carries on', async () => {
      await setUp(PLAIN);
      const open = h.standin.openConversations();
      standin().conversationDeleteDelayMs = 1500;
      const waited = copies().requestWaitMs;
      copies().requestWaitMs = 200;
      try {
        const session = data<VoiceSessionView>(await talk(PLAIN));
        h.standin.setConversation(session.conversationId!, {
          status: 'done',
          seconds: 61,
        });
        const t0 = Date.now();
        const res = await h
          .http()
          .post(`/ai-tools/receptionist/voice-sessions/${session.id}/end`)
          .set(auth(PLAIN));
        expect(Date.now() - t0).toBeLessThan(1200);
        expect(data<VoiceSessionView>(res).state).toBe('done');
        // The delete is still on its way; once it ends the note is proven gone and cleared.
        expect(h.standin.openConversations()).toBe(open + 1);
        await copies().idle();
        expect(standin().deletedConversations).toEqual([
          session.conversationId,
        ]);
        expect(h.standin.openConversations()).toBe(open);
        expect(await ref(session.id)).toBeNull();
      } finally {
        copies().requestWaitMs = waited;
        standin().conversationDeleteDelayMs = 0;
      }
    });
  });

  describe('the proof, the retries and the sweep, scripted', () => {
    const copy = (id: string) => ({ kind: 'conversation' as const, id });

    it('sends a delete only after a read shows it finished, marks the note first, and clears it only when a read by id says 404 and the list lacks it', async () => {
      const row = await noteRow('conversation:conv-1');
      const s = scripted('conv-1', ['done', 'absent']);
      await s.service.discard(row.id, copy('conv-1'));
      expect(s.calls).toEqual(['read', 'delete', 'read', 'list']);
      expect(await ref(row.id)).toBeNull();
    });

    it('keeps the note when the delete is answered 204 but the conversation is still there, and clears it on a later read that says 404 with the list empty', async () => {
      const row = await noteRow('conversation:conv-2');
      const s = scripted('conv-2', ['done', 'done', 'absent']);
      await s.service.discard(row.id, copy('conv-2'));
      expect(s.calls).toEqual(['read', 'delete', 'read']);
      expect(await ref(row.id)).toMatch(/^conversation:conv-2@\d+$/);
      expect(await s.service.sweep(later())).toEqual({
        cleared: 1,
        pending: 0,
      });
      expect(s.calls).toEqual(['read', 'delete', 'read', 'read', 'list']);
      expect(await ref(row.id)).toBeNull();
    });

    it('does not take a 404 by id as proof after a delete while the list still holds the conversation', async () => {
      const row = await noteRow('conversation:conv-3');
      // Deleted when done; the read by id says 404 at once but the list still shows it (it lags, or it is kept).
      const s = scripted(
        'conv-3',
        ['done', 'absent', 'absent'],
        ['done', 'absent'],
      );
      await s.service.discard(row.id, copy('conv-3'));
      expect(s.calls).toEqual(['read', 'delete', 'read', 'list']);
      expect(await ref(row.id)).toMatch(/^conversation:conv-3@\d+$/);
      // The next pass: 404 by id, and the list no longer has it.
      expect(await s.service.sweep(later())).toEqual({
        cleared: 1,
        pending: 0,
      });
      expect(await ref(row.id)).toBeNull();
    });

    it('does not clear a note when the list cannot be read', async () => {
      const row = await noteRow('conversation:conv-4');
      const s = scripted(
        'conv-4',
        ['done', 'absent', 'absent'],
        ['unknown', 'absent'],
      );
      await s.service.discard(row.id, copy('conv-4'));
      expect(await ref(row.id)).toMatch(/^conversation:conv-4@\d+$/);
      expect(await s.service.sweep(later())).toEqual({
        cleared: 1,
        pending: 0,
      });
    });

    it('counts a delete whose answer was lost: a later 404 by id with the list empty clears the note', async () => {
      const row = await noteRow('conversation:conv-5');
      const s = scripted('conv-5', ['done', 'absent']);
      s.deletes.push('failed');
      await s.service.discard(row.id, copy('conv-5'));
      expect(s.calls).toEqual(['read', 'delete']);
      expect(await ref(row.id)).toMatch(/^conversation:conv-5@\d+$/);
      expect(await s.service.sweep(later())).toEqual({
        cleared: 1,
        pending: 0,
      });
      expect(await ref(row.id)).toBeNull();
    });

    it('does not clear a note on a 404 when no delete was sent, whatever the list says about absence, and does nothing on an answer it cannot read', async () => {
      const row = await noteRow('conversation:conv-6');
      const s = scripted('conv-6', [
        'absent',
        'unknown',
        'in-progress',
        'processing',
      ]);
      for (let i = 0; i < 4; i += 1)
        expect(await s.service.sweep(later())).toEqual({
          cleared: 0,
          pending: 1,
        });
      // 404 by id read the list (the note is old enough); the others stopped at the read.
      expect(s.calls).toEqual(['read', 'list', 'read', 'read', 'read']);
      expect(await ref(row.id)).toBe('conversation:conv-6');
    });

    it('does not read the list for a young note the provider answers 404 for: it is probably not stored yet', async () => {
      const row = await noteRow('conversation:conv-7');
      const s = scripted('conv-7', ['absent']);
      await s.service.discard(row.id, copy('conv-7'));
      expect(s.calls).toEqual(['read']);
      expect(await ref(row.id)).toBe('conversation:conv-7');
    });

    it('finds a conversation that reads 404 by id in the list (its agent was deleted), deletes it by id once finished, and clears it when the read by id and the list agree', async () => {
      const row = await noteRow('conversation:conv-8');
      // Pass 1: 404 by id, listed and still processing: nothing is sent. Pass 2: listed and done: marked, deleted, then
      // 404 by id and an empty list.
      const s = scripted(
        'conv-8',
        ['absent', 'absent', 'absent'],
        ['processing', 'done', 'absent'],
      );
      expect(await s.service.sweep(later())).toEqual({
        cleared: 0,
        pending: 1,
      });
      expect(s.calls).toEqual(['read', 'list']);
      expect(await s.service.sweep(later())).toEqual({
        cleared: 1,
        pending: 0,
      });
      expect(s.calls).toEqual([
        'read',
        'list',
        'read',
        'list',
        'delete',
        'read',
        'list',
      ]);
      expect(await ref(row.id)).toBeNull();
    });

    it('treats failed like done', async () => {
      const row = await noteRow('conversation:conv-9');
      const s = scripted('conv-9', ['failed', 'absent']);
      expect(await s.service.sweep(later())).toEqual({
        cleared: 1,
        pending: 0,
      });
      expect(s.calls).toEqual(['read', 'delete', 'read', 'list']);
      expect(await ref(row.id)).toBeNull();
    });

    it('drops a note older than 25 hours with one warning and sends nothing to the provider; a note under 25 hours is still tried; one over 48 hours is left alone', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const hours = (n: number) => new Date(Date.now() - n * 3_600_000);
      const drop = await noteRow('conversation:conv-10', {
        createdAt: hours(26),
        finishedAt: hours(26),
      });
      const tried = await noteRow('conversation:conv-11', {
        createdAt: hours(24),
        finishedAt: hours(24),
      });
      const stale = await noteRow('conversation:conv-12', {
        createdAt: hours(50),
        finishedAt: hours(50),
      });
      const s = scripted('conv-11', ['in-progress']);
      expect(await s.service.sweep(new Date())).toEqual({
        cleared: 1,
        pending: 1,
      });
      // Only the 24 hour note was read.
      expect(s.calls).toEqual(['read']);
      expect(await ref(drop.id)).toBeNull();
      expect(await ref(tried.id)).toBe('conversation:conv-11');
      expect(await ref(stale.id)).toBe('conversation:conv-12');
      const dropped = warn.mock.calls.filter((c) =>
        String(c[0]).includes('25 hours'),
      );
      expect(dropped).toHaveLength(1);
      expect(String(dropped[0][0])).not.toContain('conv-10');
      expect(String(dropped[0][0])).not.toMatch(/[–—]/);
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
      const row = await noteRow('conversation:conv-13', {
        finishedAt: finished,
      });
      const s = scripted('conv-13', ['done']);
      expect(await s.service.sweep(new Date())).toEqual({
        cleared: 0,
        pending: 1,
      });
      expect(s.calls).toEqual([]);
      expect(await ref(row.id)).toBe('conversation:conv-13');
    });

    it('tries the newest due notes first and at most 50 a pass, so a pile of older notes never keeps a newer one waiting', async () => {
      const base = Date.now() - 150_000;
      const rows: { id: string; ref: string }[] = [];
      for (let i = 0; i < 60; i += 1) {
        const at = new Date(base + i * 1000);
        const r = `conversation:conv-pile-${String(i).padStart(2, '0')}`;
        rows.push({
          id: (await noteRow(r, { createdAt: at, finishedAt: at })).id,
          ref: r,
        });
      }
      const seen: string[] = [];
      const voice = {
        readConversation: (id: string) => {
          seen.push(id);
          return Promise.resolve({ status: 'processing', seconds: null });
        },
        deleteConversation: () => Promise.resolve('deleted'),
      } as unknown as AiVoiceProvider;
      const service = new ProviderCopyService(h.prisma, voice, settings);
      service.delaysMs = [];
      expect(await service.sweep(new Date())).toEqual({
        cleared: 0,
        pending: 60,
      });
      expect(seen).toHaveLength(50);
      // The 50 newest (indexes 10 to 59), newest first; the 10 oldest wait for a later pass.
      expect(seen[0]).toBe('conv-pile-59');
      expect(seen).not.toContain('conv-pile-00');
      expect(seen).not.toContain('conv-pile-09');
      expect(seen).toContain('conv-pile-10');
    });

    it('shares the in-process retries: a burst of notes starts no more than the limit, the rest wait for the sweep', async () => {
      const ids = [1, 2, 3, 4, 5].map((n) => `conv-burst-${n}`);
      const rows = await Promise.all(
        ids.map((id) => noteRow(`conversation:${id}`)),
      );
      let reads = 0;
      const voice = {
        readConversation: () => {
          reads += 1;
          return Promise.resolve({ status: 'processing', seconds: null });
        },
        deleteConversation: () => Promise.resolve('deleted'),
      } as unknown as AiVoiceProvider;
      const service = new ProviderCopyService(h.prisma, voice, settings);
      service.delaysMs = [30];
      service.retryLimit = 2;
      await Promise.all(
        rows.map((r, i) => service.discard(r.id, copy(ids[i]))),
      );
      expect(reads).toBe(5);
      await new Promise((r) => setTimeout(r, 400));
      // Five first tries and one retry for each of the two loops that were allowed: seven, not ten.
      expect(reads).toBe(7);
      service.onModuleDestroy();
    });

    it('waits for a slow delete only a moment when a request asks, and lets it carry on', async () => {
      const row = await noteRow('conversation:conv-14');
      const s = scripted('conv-14', ['done', 'absent'], [], 400);
      s.service.requestWaitMs = 50;
      const t0 = Date.now();
      await s.service.discardWithin(row.id, copy('conv-14'));
      expect(Date.now() - t0).toBeLessThan(300);
      expect(await ref(row.id)).toMatch(/^conversation:conv-14@\d+$/);
      await s.service.idle();
      expect(s.calls).toEqual(['read', 'delete', 'read', 'list']);
      expect(await ref(row.id)).toBeNull();
    });
  });
});
