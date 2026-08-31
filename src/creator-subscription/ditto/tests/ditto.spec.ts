import { ForbiddenException } from '@nestjs/common';
import { DittoService } from '../ditto.service';
import type { DittoInviteClient } from '../ditto-invite.client';
import type { PrismaService } from '../../../common/prisma/prisma.service';
import { DITTO_DISCOUNT_PERCENT, DITTO_SIGNUP_URL } from '../ditto.constants';

/**
 * Ditto distribution is an OPT-IN, and these tests exist to keep it one.
 *
 * The requirement is explicit: a Pro Max creator must press a button. Paying
 * is not consent to be enrolled with a third party, so the test that matters
 * most here is the one asserting that a fully paid Pro Max account which has
 * pressed nothing is NOT opted in and has NOT been sent anything.
 */
interface OptInRow {
  wawuUserId: string;
  optedInAt: Date;
  emailedAt: Date | null;
}

function build(opts: { tier?: 'basic' | 'pro' | 'pro_max' | null; row?: OptInRow | null; emailWorks?: boolean }) {
  const rows = new Map<string, OptInRow>();
  if (opts.row) rows.set(opts.row.wawuUserId, opts.row);
  const sent: string[] = [];

  const prisma = {
    creatorState: {
      findUnique: async () => (opts.tier ? { tier: opts.tier } : null),
    },
    dittoOptIn: {
      findUnique: async ({ where }: { where: { wawuUserId: string } }) =>
        rows.get(where.wawuUserId) ?? null,
      create: async ({ data }: { data: { wawuUserId: string } }) => {
        const row: OptInRow = { wawuUserId: data.wawuUserId, optedInAt: new Date(), emailedAt: null };
        rows.set(data.wawuUserId, row);
        return row;
      },
      update: async ({ where, data }: { where: { wawuUserId: string }; data: { emailedAt: Date } }) => {
        const row = rows.get(where.wawuUserId)!;
        row.emailedAt = data.emailedAt;
        return row;
      },
    },
  } as unknown as PrismaService;

  const invites = {
    send: async (userId: string) => {
      sent.push(userId);
      return opts.emailWorks ?? true;
    },
  } as unknown as DittoInviteClient;

  return { service: new DittoService(prisma, invites), sent, rows };
}

describe('Ditto opt-in', () => {
  it('does NOT opt a paid Pro Max creator in by itself', async () => {
    // The requirement in one assertion: buying the plan enrols nobody.
    const { service, sent } = build({ tier: 'pro_max' });
    const state = await service.stateFor('creator-1');
    expect(state.eligible).toBe(true);
    expect(state.optedIn).toBe(false);
    expect(sent).toEqual([]);
  });

  it('withholds the signup link until they have opted in', async () => {
    // The discount rides on the link, so handing it to everyone who loads
    // their billing page gives the benefit away without the consent.
    const { service } = build({ tier: 'pro_max' });
    expect((await service.stateFor('creator-1')).signupUrl).toBeNull();
    const after = await service.optIn('creator-1');
    expect(after.signupUrl).toBe(DITTO_SIGNUP_URL);
  });

  it('sends the invite once they press the button', async () => {
    const { service, sent } = build({ tier: 'pro_max' });
    const state = await service.optIn('creator-1');
    expect(state.optedIn).toBe(true);
    expect(state.emailed).toBe(true);
    expect(sent).toEqual(['creator-1']);
  });

  it('quotes the discount the plan is sold with', async () => {
    const { service } = build({ tier: 'pro_max' });
    expect((await service.stateFor('creator-1')).discountPercent).toBe(25);
    expect(DITTO_DISCOUNT_PERCENT).toBe(25);
  });

  it('refuses a creator whose plan does not include distribution', async () => {
    for (const tier of ['basic', 'pro'] as const) {
      const { service, sent } = build({ tier });
      await expect(service.optIn('creator-1')).rejects.toBeInstanceOf(ForbiddenException);
      expect(sent).toEqual([]);
    }
  });

  it('is idempotent — pressing twice does not send a second email', async () => {
    // A button a creator can press repeatedly must not be a way to mail-bomb
    // their own inbox.
    const { service, sent } = build({ tier: 'pro_max' });
    await service.optIn('creator-1');
    await service.optIn('creator-1');
    expect(sent).toEqual(['creator-1']);
  });

  it('keeps the opt-in even when the email could not be sent', async () => {
    // A phone-OTP signup has no address. Losing the opt-in over that would
    // show the button again as though they had never pressed it, and the link
    // is in the app regardless.
    const { service } = build({ tier: 'pro_max', emailWorks: false });
    const state = await service.optIn('creator-1');
    expect(state.optedIn).toBe(true);
    expect(state.emailed).toBe(false);
    expect(state.signupUrl).toBe(DITTO_SIGNUP_URL);
  });

  it('tells a non-Pro-Max creator the plan is not eligible rather than pretending', async () => {
    const { service } = build({ tier: 'basic' });
    const state = await service.stateFor('creator-1');
    expect(state.eligible).toBe(false);
    expect(state.optedIn).toBe(false);
  });
});
