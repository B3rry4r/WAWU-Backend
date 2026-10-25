import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { AdminRole } from '../../../../generated/prisma/enums';
import { AdminAuthGuard } from '../../../admin/auth/guards/admin-auth.guard';
import { AdminRolesGuard } from '../../../admin/auth/guards/admin-roles.guard';
import { ADMIN_ROLES_KEY } from '../../../admin/auth/decorators/admin-roles.decorator';
import { AdminTransferLookupQueryDto } from '../admin-transfer-lookup.dto';
import {
  AdminTransferLookupService,
  LOOKUP_LIMIT,
} from '../admin-transfer-lookup.service';
import { AdminTransfersController } from '../admin-transfers.controller';
import { parseReferenceQuery, shortReferenceOf } from '../transfer-reference';

/*
 * R2-MONEY D-03: support finds a send by the short reference on the receipt ("WAW-XXXX-XXXX"). The short form is derived from the stored
 * reference (never stored), the lookup is admin-guarded, reads our own rows, and answers every send the reference fits.
 */
const ID = '8f2a91c3-5b7e-4d10-a6c2-0123456789ab';

describe('the short reference of a send', () => {
  it('is the first eight hex digits of the send id, upper case, in two groups of four, for a send to a WAWU user and to a bank', () => {
    expect(shortReferenceOf(`wawu-send-${ID}`)).toBe('WAW-8F2A-91C3');
    expect(shortReferenceOf(`wawu-bank-${ID}`)).toBe('WAW-8F2A-91C3');
    expect(shortReferenceOf(`WAWU-SEND-${ID.toUpperCase()}`)).toBe(
      'WAW-8F2A-91C3',
    );
  });

  it('is null for a reference of another shape, which is shown whole', () => {
    for (const other of [
      `wawu-bank-sch-${ID}`,
      `wawu-send-${ID}-fee`,
      'WAW-8F2A-91C3',
      'FLW-1234',
      `wawu-send-${ID.slice(0, 20)}`,
      '',
    ]) {
      expect(shortReferenceOf(other)).toBeNull();
    }
  });

  it('is the same every time and fits its own query: what the receipt shows is what the lookup parses', () => {
    for (let i = 0; i < 200; i += 1) {
      const id = randomUUID();
      const reference = `wawu-send-${id}`;
      const short = shortReferenceOf(reference);
      expect(short).toMatch(/^WAW-[0-9A-F]{4}-[0-9A-F]{4}$/);
      expect(shortReferenceOf(reference)).toBe(short);
      const query = parseReferenceQuery(short as string);
      expect(query).toEqual({ kind: 'short', hex: id.slice(0, 8) });
      expect(
        reference.startsWith(`wawu-send-${(query as { hex: string }).hex}`),
      ).toBe(true);
    }
  });
});

describe('what the lookup is asked', () => {
  it('reads a short reference in any case and with spaces around it, and any other text whole; blank is no query', () => {
    expect(parseReferenceQuery(' waw-8f2a-91c3 ')).toEqual({
      kind: 'short',
      hex: '8f2a91c3',
    });
    expect(parseReferenceQuery(`wawu-bank-${ID}`)).toEqual({
      kind: 'whole',
      reference: `wawu-bank-${ID}`,
    });
    expect(parseReferenceQuery('WAW-8F2A-91C')).toEqual({
      kind: 'whole',
      reference: 'WAW-8F2A-91C',
    });
    expect(parseReferenceQuery('   ')).toBeNull();
  });

  it('refuses a reference that is too short or too long, as a bad request', async () => {
    const make = (reference: unknown) =>
      plainToInstance(AdminTransferLookupQueryDto, { reference });
    expect(await validate(make('WAW'))).not.toHaveLength(0);
    expect(await validate(make('x'.repeat(121)))).not.toHaveLength(0);
    expect(await validate(make(7))).not.toHaveLength(0);
    expect(await validate(make('WAW-8F2A-91C3'))).toHaveLength(0);
  });
});

describe('the lookup', () => {
  const row = (id: string, kind: 'send' | 'bank', createdAt: string) => ({
    id,
    kind: kind === 'send' ? 'wawu_user' : 'bank_account',
    status: 'completed',
    customerReference: `wawu-${kind}-${id}`,
    amountKobo: BigInt(500_000),
    providerFeeKobo: BigInt(0),
    wawuFeeKobo: BigInt(1000),
    totalKobo: BigInt(501_000),
    payerWawuUserId: 'payer-1',
    recipientWawuUserId: kind === 'send' ? 'payee-1' : null,
    payerName: 'Ada Eze',
    recipientName: kind === 'send' ? 'Femi Ade' : null,
    bankName: kind === 'bank' ? 'GTBank' : null,
    createdAt: new Date(createdAt),
    completedAt: new Date(createdAt),
  });
  const service = (rows: unknown[]) => {
    const findMany = jest.fn(() => Promise.resolve(rows));
    return {
      findMany,
      service: new AdminTransferLookupService({
        walletTransfer: { findMany },
      } as never),
    };
  };

  it("finds the sends that begin with the short reference, for both kinds of send, and shows each one's short and whole reference", async () => {
    const { findMany, service: lookup } = service([
      row(ID, 'send', '2026-10-24T10:00:00.000Z'),
    ]);
    const out = await lookup.lookup('WAW-8F2A-91C3');
    const args = findMany.mock.calls[0] as unknown as [
      { where: unknown; take: number; select: Record<string, boolean> },
    ];
    expect(args[0].where).toEqual({
      OR: [
        { customerReference: { startsWith: 'wawu-send-8f2a91c3' } },
        { customerReference: { startsWith: 'wawu-bank-8f2a91c3' } },
      ],
    });
    expect(args[0].take).toBe(LOOKUP_LIMIT);
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({
      id: ID,
      reference: `wawu-send-${ID}`,
      shortReference: 'WAW-8F2A-91C3',
      amountKobo: 500_000,
      totalKobo: 501_000,
      payerName: 'Ada Eze',
    });
  });

  it('asks for the whole reference exactly when given one, and answers a bank send with its bank and no account number', async () => {
    const { findMany, service: lookup } = service([
      row(ID, 'bank', '2026-10-24T10:00:00.000Z'),
    ]);
    const out = await lookup.lookup(`wawu-bank-${ID}`);
    const args = findMany.mock.calls[0] as unknown as [
      { where: unknown; select: Record<string, boolean> },
    ];
    expect(args[0].where).toEqual({ customerReference: `wawu-bank-${ID}` });
    expect(out.items[0].bankName).toBe('GTBank');
    expect(
      Object.keys(args[0].select).filter((k) =>
        /account(number|name)/i.test(k),
      ),
    ).toEqual([]);
    expect(JSON.stringify(out)).not.toMatch(/accountNumber/i);
  });

  it('answers an empty list for a blank query and asks the database nothing', async () => {
    const { findMany, service: lookup } = service([]);
    expect(await lookup.lookup('   ')).toEqual({ items: [] });
    expect(findMany).not.toHaveBeenCalled();
  });

  it('is behind the admin guards and open to superadmin, finance and support only', () => {
    const guards = Reflect.getMetadata(
      '__guards__',
      AdminTransfersController,
    ) as unknown[];
    expect(guards).toEqual([AdminAuthGuard, AdminRolesGuard]);
    const find = (
      AdminTransfersController.prototype as unknown as Record<string, object>
    ).find;
    const roles = Reflect.getMetadata(ADMIN_ROLES_KEY, find) as AdminRole[];
    expect([...roles].sort()).toEqual(
      [AdminRole.finance, AdminRole.superadmin, AdminRole.support].sort(),
    );
    expect(Reflect.getMetadata('path', AdminTransfersController)).toBe(
      'admin/money/transfers',
    );
    expect(Reflect.getMetadata('path', find)).toBe('lookup');
  });
});
