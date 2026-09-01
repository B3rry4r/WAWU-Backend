import { ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';
import { ReferralService } from '../referral.service';
import type { PrismaService } from '../../common/prisma/prisma.service';
import type { CreatorTier } from '../../../generated/prisma/enums';

/**
 * Referral codes: a discount on one plan, and a way in while regular signup
 * is closed.
 *
 * The properties that matter, and why each is here:
 *  - 0% must be allowed. It is how a hand-picked creator is admitted at the
 *    normal price, and a validator that treats 0 as "no discount supplied"
 *    would silently reject exactly that case.
 *  - Validating must not spend a use. It runs on every keystroke.
 *  - A code must not be spendable twice by one account, or past its cap.
 */
const PRICES: Record<CreatorTier, number> = { basic: 5999, pro: 14999, pro_max: 29999 };

interface Row {
  code: string;
  label: string;
  discountPercent: number;
  tier: CreatorTier;
  active: boolean;
  maxUses: number | null;
  usedCount: number;
  expiresAt: Date | null;
}

function build(opts: { rows?: Row[]; userSignupEnabled?: boolean } = {}) {
  const rows = new Map<string, Row>((opts.rows ?? []).map((r) => [r.code, r]));
  const redemptions = new Set<string>();

  const prisma = {
    platformSettings: {
      findUnique: async () =>
        opts.userSignupEnabled === undefined
          ? null
          : { id: 1, userSignupEnabled: opts.userSignupEnabled },
      upsert: async ({ create }: { create: { userSignupEnabled: boolean } }) => create,
    },
    referralCode: {
      findUnique: async ({ where }: { where: { code: string } }) => rows.get(where.code) ?? null,
      update: async ({ where }: { where: { code: string } }) => {
        const r = rows.get(where.code)!;
        r.usedCount += 1;
        return r;
      },
      updateMany: async ({ where }: { where: { code: string; usedCount: { lt: number } } }) => {
        const r = rows.get(where.code);
        if (!r || r.usedCount >= where.usedCount.lt) return { count: 0 };
        r.usedCount += 1;
        return { count: 1 };
      },
    },
    referralRedemption: {
      findUnique: async ({ where }: { where: { code_wawuUserId: { code: string; wawuUserId: string } } }) =>
        redemptions.has(`${where.code_wawuUserId.code}:${where.code_wawuUserId.wawuUserId}`)
          ? { id: 'x' }
          : null,
      create: async ({ data }: { data: { code: string; wawuUserId: string } }) => {
        redemptions.add(`${data.code}:${data.wawuUserId}`);
        return data;
      },
    },
  } as unknown as PrismaService;

  return { service: new ReferralService(prisma), rows, redemptions };
}

const code = (over: Partial<Row> = {}): Row => ({
  code: 'LAUNCH',
  label: 'Blog',
  discountPercent: 25,
  tier: 'pro',
  active: true,
  maxUses: null,
  usedCount: 0,
  expiresAt: null,
  ...over,
});

describe('referral codes', () => {
  it('prices a discount off the plan it applies to', async () => {
    const { service } = build({ rows: [code({ discountPercent: 25, tier: 'pro' })] });
    const v = await service.validate('LAUNCH', PRICES);
    expect(v.originalPriceNaira).toBe(14999);
    expect(v.priceNaira).toBe(11249); // 25% off, rounded to whole naira
    expect(v.discountPercent).toBe(25);
  });

  it('ALLOWS a 0% code — it is an invitation, not a discount', async () => {
    // The case a naive "if (!discount)" would reject: letting somebody
    // through the closed door at the normal price.
    const { service } = build({ rows: [code({ discountPercent: 0 })] });
    const v = await service.validate('LAUNCH', PRICES);
    expect(v.discountPercent).toBe(0);
    expect(v.priceNaira).toBe(v.originalPriceNaira);
  });

  it('accepts a 100% code without going negative', async () => {
    const { service } = build({ rows: [code({ discountPercent: 100 })] });
    expect((await service.validate('LAUNCH', PRICES)).priceNaira).toBe(0);
  });

  it('matches codes case-insensitively and ignores stray spaces', async () => {
    // These are read off a blog post and typed by hand. A code that works in
    // the email and fails in the form is the worst bug this feature can have.
    const { service } = build({ rows: [code()] });
    for (const typed of ['launch', '  LaUnCh  ', 'LAUNCH']) {
      await expect(service.validate(typed, PRICES)).resolves.toMatchObject({ code: 'LAUNCH' });
    }
  });

  it('does NOT spend a use when validating', async () => {
    const { service, rows } = build({ rows: [code({ maxUses: 1 })] });
    await service.validate('LAUNCH', PRICES);
    await service.validate('LAUNCH', PRICES);
    expect(rows.get('LAUNCH')!.usedCount).toBe(0);
  });

  it('refuses an inactive, expired, or used-up code with one message', async () => {
    // One message for every rejection: distinguishing them tells somebody
    // probing which of their guesses were real codes.
    const cases: Partial<Row>[] = [
      { active: false },
      { expiresAt: new Date(Date.now() - 1000) },
      { maxUses: 2, usedCount: 2 },
    ];
    for (const over of cases) {
      const { service } = build({ rows: [code(over)] });
      await expect(service.validate('LAUNCH', PRICES)).rejects.toBeInstanceOf(NotFoundException);
    }
    const { service } = build({ rows: [] });
    await expect(service.validate('NOPE', PRICES)).rejects.toThrow('That code is not valid.');
  });

  it('refuses to redeem against a different plan than it was issued for', async () => {
    const { service } = build({ rows: [code({ tier: 'pro' })] });
    await expect(service.redeem('LAUNCH', 'u1', 'basic')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('is idempotent per account — a retried payment does not spend two uses', async () => {
    const { service, rows } = build({ rows: [code({ maxUses: 5 })] });
    await service.redeem('LAUNCH', 'u1', 'pro');
    await service.redeem('LAUNCH', 'u1', 'pro');
    expect(rows.get('LAUNCH')!.usedCount).toBe(1);
  });

  it('enforces the use cap across different accounts', async () => {
    const { service } = build({ rows: [code({ maxUses: 1 })] });
    await service.redeem('LAUNCH', 'u1', 'pro');
    await expect(service.redeem('LAUNCH', 'u2', 'pro')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('treats an unlimited code as unlimited', async () => {
    const { service, rows } = build({ rows: [code({ maxUses: null })] });
    for (const u of ['u1', 'u2', 'u3']) await service.redeem('LAUNCH', u, 'pro');
    expect(rows.get('LAUNCH')!.usedCount).toBe(3);
  });
});

describe('regular-user signup gate', () => {
  it('is OPEN when nothing has been configured', async () => {
    // An absent settings row must not read as "closed" — that would lock
    // every environment that has never touched the switch.
    const { service } = build({});
    await expect(service.userSignupEnabled()).resolves.toBe(true);
    await expect(service.assertMayCreateUserAccount(undefined)).resolves.toBeUndefined();
  });

  it('refuses a regular account with no code once closed', async () => {
    const { service } = build({ userSignupEnabled: false });
    await expect(service.assertMayCreateUserAccount(undefined)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lets a valid code through while closed', async () => {
    const { service } = build({ userSignupEnabled: false, rows: [code({ discountPercent: 0 })] });
    await expect(service.assertMayCreateUserAccount('launch')).resolves.toBeUndefined();
  });

  it('does not spend the code just to get through the door', async () => {
    // Creating an account is not buying a plan. Burning a single-use code on
    // a signup that never subscribes would waste it.
    const { service, rows } = build({ userSignupEnabled: false, rows: [code({ maxUses: 1 })] });
    await service.assertMayCreateUserAccount('LAUNCH');
    expect(rows.get('LAUNCH')!.usedCount).toBe(0);
  });

  it('still refuses an invalid code while closed', async () => {
    const { service } = build({ userSignupEnabled: false, rows: [code({ active: false })] });
    await expect(service.assertMayCreateUserAccount('LAUNCH')).rejects.toBeInstanceOf(ForbiddenException);
  });
});
