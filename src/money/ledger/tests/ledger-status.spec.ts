import { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../../common/prisma/prisma.service';
import type { FintavaClient } from '../../../fintava/fintava-client';
import { ledgerStatusCheckAfterMs } from '../ledger-config';
import { LedgerStatusService } from '../ledger-status.service';
import type { LedgerService } from '../ledger.service';

/**
 * The pending sweep's rules that need no database (task MONEY-08): its
 * timing setting, and a server with no Fintava settings (production before
 * OPS-10), where nothing may be sent and nothing may change.
 */
describe('ledger status: settings and an unconfigured server', () => {
  it('checks rows 2 minutes old unless set; whole minutes from 1 to 1440', () => {
    expect(ledgerStatusCheckAfterMs(undefined)).toBe(2 * 60_000);
    expect(ledgerStatusCheckAfterMs('')).toBe(2 * 60_000);
    expect(ledgerStatusCheckAfterMs(' 5 ')).toBe(5 * 60_000);
    for (const bad of ['0', '1.5', '-1', '1441', 'two']) {
      expect(() => ledgerStatusCheckAfterMs(bad)).toThrow(
        /LEDGER_STATUS_CHECK_AFTER_MINUTES/,
      );
    }
  });

  it('with Fintava not configured, a pending row stays pending and nothing is asked or written', async () => {
    const now = new Date();
    const row = {
      id: 'e1',
      status: 'pending',
      discrepancy: null,
      direction: 'out',
      walletKind: 'merchant',
      customerReference: 'OURS-1',
      category: 'transfer',
      counterpartyKind: null,
      createdAt: now,
      updatedAt: now,
      occurredAt: now,
    };
    const writes: string[] = [];
    const prisma = {
      fintavaLedgerEntry: {
        findUnique: () => Promise.resolve(row),
        findMany: () => Promise.resolve([{ id: 'e1' }]),
      },
    } as unknown as PrismaService;
    const fintava = new Proxy(
      { environment: 'unconfigured' },
      {
        get(target, key) {
          if (key in target) return target[key as keyof typeof target];
          return () => {
            throw new Error(`Fintava was asked: ${String(key)}`);
          };
        },
      },
    ) as unknown as FintavaClient;
    const ledger = new Proxy(
      {},
      {
        get: (_t, key) => () => {
          writes.push(String(key));
          return Promise.resolve(null);
        },
      },
    ) as unknown as LedgerService;
    const service = new LedgerStatusService(
      prisma,
      fintava,
      ledger,
      new ConfigService({}),
    );
    expect(await service.check('e1', now)).toMatchObject({
      outcome: 'waiting',
      status: 'pending',
      why: 'not_configured',
    });
    const counts = await service.sweep(new Date(now.getTime() + 600_000));
    expect(counts.waiting).toBe(1);
    expect(writes).toEqual([]);
  });
});
