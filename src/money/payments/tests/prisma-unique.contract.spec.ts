import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  isUniqueViolation,
  isUniqueViolationOn,
  uniqueViolationTargets,
} from '../../prisma-unique';
import { isOpenKeyClash } from '../wallet-payment.service';

/**
 * Reading a unique-constraint refusal (MONEY-17 round 3, verifier defect
 * R2-2). The first block makes REAL unique clashes in the test database
 * through the real Prisma 7 `pg` adapter, so what is read is what Prisma
 * really reports (`meta.driverAdapterError.cause.constraint.fields`, with
 * `meta.target` unset), not an error object written by hand. The second block
 * covers the fallback for a Prisma that still sets `meta.target`.
 */
describe('reading a P2002 (prisma-unique)', () => {
  let prisma: PrismaService;
  const payers: string[] = [];

  const base = (payer: string, openKey: string | null) => {
    const id = randomUUID();
    return {
      id,
      payerWawuUserId: payer,
      kind: 'content_unlock',
      targetId: 'unique-probe',
      title: 'probe',
      priceKobo: 1n,
      providerFeeKobo: 0n,
      wawuFeeKobo: 0n,
      totalKobo: 1n,
      payeeShareKobo: 0n,
      wawuShareKobo: 1n,
      customerReference: `wawu-pay-${id}`,
      payerAccountNumber: '0000000000',
      merchantAccountNumber: '1111111111',
      status: 'pending',
      openKey,
    };
  };

  async function clash(
    make: (first: ReturnType<typeof base>) => ReturnType<typeof base>,
  ): Promise<unknown> {
    const payer = randomUUID();
    payers.push(payer);
    const first = base(payer, `${payer}:content_unlock:unique-probe`);
    await prisma.walletPayment.create({ data: first });
    try {
      await prisma.walletPayment.create({ data: make(first) });
    } catch (e) {
      return e;
    }
    throw new Error('the second insert was not refused');
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.walletPayment.deleteMany({
      where: { payerWawuUserId: { in: payers } },
    });
    await prisma.$disconnect();
  });

  it('a second payment with the same openKey is read as a clash on openKey', async () => {
    const e = await clash((first) => ({
      ...base(first.payerWawuUserId, first.openKey),
    }));
    expect(isUniqueViolation(e)).toBe(true);
    expect(uniqueViolationTargets(e)).toEqual(['openKey']);
    expect(isUniqueViolationOn(e, 'openKey')).toBe(true);
    expect(isOpenKeyClash(e)).toBe(true);
    expect(isUniqueViolationOn(e, 'customerReference')).toBe(false);
  });

  it('a clash on another unique column is NOT an openKey clash', async () => {
    const e = await clash((first) => ({
      ...base(first.payerWawuUserId, null),
      customerReference: first.customerReference,
    }));
    expect(isUniqueViolation(e)).toBe(true);
    expect(uniqueViolationTargets(e)).toEqual(['customerReference']);
    expect(isUniqueViolationOn(e, 'customerReference')).toBe(true);
    expect(isOpenKeyClash(e)).toBe(false);
  });

  it('a clash on the primary key is read too', async () => {
    const e = await clash((first) => ({
      ...base(first.payerWawuUserId, null),
      id: first.id,
    }));
    expect(isUniqueViolationOn(e, 'id')).toBe(true);
    expect(isOpenKeyClash(e)).toBe(false);
  });

  it('what is read comes from the adapter, which leaves meta.target unset (so a target-only reader would never see it)', async () => {
    const e = (await clash((first) => ({
      ...base(first.payerWawuUserId, first.openKey),
    }))) as { meta?: { target?: unknown; driverAdapterError?: unknown } };
    expect(e.meta?.driverAdapterError).toBeDefined();
    const targetOnly = JSON.stringify(e.meta?.target ?? '').includes('openKey');
    expect(targetOnly).toBe(false);
    expect(isOpenKeyClash(e)).toBe(true);
  });

  describe('fallbacks and refusals', () => {
    it('reads meta.target (an array, or a string) when the adapter reports nothing', () => {
      expect(
        isUniqueViolationOn(
          { code: 'P2002', meta: { target: ['openKey'] } },
          'openKey',
        ),
      ).toBe(true);
      expect(
        isUniqueViolationOn(
          { code: 'P2002', meta: { target: 'WalletPayment_openKey_key' } },
          'openKey',
        ),
      ).toBe(true);
    });

    it('reads the constraint name when only that is given, and strips quotes from fields', () => {
      const named = {
        code: 'P2002',
        meta: {
          driverAdapterError: {
            cause: { constraint: { index: 'WalletPayment_openKey_key' } },
          },
        },
      };
      expect(isUniqueViolationOn(named, 'openKey')).toBe(true);
      const quoted = {
        code: 'P2002',
        meta: {
          driverAdapterError: {
            cause: { constraint: { fields: ['"openKey"'] } },
          },
        },
      };
      expect(uniqueViolationTargets(quoted)).toEqual(['openKey']);
    });

    it('is not fooled by a column that merely contains the name, or by another error', () => {
      expect(
        isUniqueViolationOn(
          { code: 'P2002', meta: { target: ['openKeyOther'] } },
          'openKey',
        ),
      ).toBe(false);
      expect(isUniqueViolationOn({ code: 'P2025' }, 'openKey')).toBe(false);
      expect(isUniqueViolationOn(null, 'openKey')).toBe(false);
      expect(isUniqueViolationOn(new Error('x'), 'openKey')).toBe(false);
      expect(isUniqueViolation({ code: 'P2002' })).toBe(true);
      expect(uniqueViolationTargets({ code: 'P2002' })).toEqual([]);
    });
  });
});
