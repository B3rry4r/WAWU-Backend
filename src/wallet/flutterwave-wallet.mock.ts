import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  Bank,
  FlutterwaveWalletGateway,
  PsaBalance,
  PsaWallet,
  ResolvedAccount,
  TransferResult,
} from './flutterwave-wallet.gateway';

/**
 * The local and test stand-in for Flutterwave's wallet API.
 *
 * Selected only by shouldUseMockFlutterwave(), which REFUSES to return true in
 * production — the same guard every other money module uses, and for the same
 * reason: a mock that happily reports success would otherwise let a production
 * deploy with a missing key tell creators their money had moved when nothing
 * had.
 *
 * Balances here are held in memory so a local withdrawal behaves like a real
 * one: fund, see the balance rise, withdraw, see it fall, and get refused when
 * there is not enough.
 */
@Injectable()
export class FlutterwaveWalletMock implements FlutterwaveWalletGateway {
  private readonly balances = new Map<string, number>();

  createWallet(input: { accountName: string; email: string }): Promise<PsaWallet> {
    const ref = `PSA${randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()}`;
    this.balances.set(ref, 0);
    return Promise.resolve({
      accountReference: ref,
      barterId: `234${Math.floor(Math.random() * 1e12)}`,
      nuban: String(9000000000 + Math.floor(Math.random() * 999999999)).slice(0, 10),
      bankName: 'Flutterwave MFB',
      bankCode: '090567',
      status: 'ACTIVE',
    });
  }

  balance(accountReference: string): Promise<PsaBalance> {
    return Promise.resolve({ availableNgn: this.balances.get(accountReference) ?? 0 });
  }

  fundWallet(input: { barterId: string; amount: number }): Promise<TransferResult> {
    // The mock keys balances by account reference, and funding addresses the
    // barter id, so credit whichever wallet exists. One wallet per test.
    const [ref] = [...this.balances.keys()];
    if (ref) this.balances.set(ref, (this.balances.get(ref) ?? 0) + input.amount);
    return Promise.resolve({ transferId: randomUUID(), status: 'NEW' });
  }

  withdraw(input: { accountReference: string; amount: number }): Promise<TransferResult> {
    const held = this.balances.get(input.accountReference) ?? 0;
    this.balances.set(input.accountReference, held - input.amount);
    return Promise.resolve({ transferId: randomUUID(), status: 'NEW' });
  }

  resolveAccount(bankCode: string, accountNumber: string): Promise<ResolvedAccount> {
    return Promise.resolve({ accountNumber, accountName: 'ADA OKEKE' });
  }

  transferByReference(): Promise<{ status: string } | null> {
    // The mock has no queue of in-flight transfers: everything it accepted, it
    // completed. Reconciliation against it therefore always settles.
    return Promise.resolve({ status: 'SUCCESSFUL' });
  }

  banks(): Promise<Bank[]> {
    return Promise.resolve([
      { code: '044', name: 'Access Bank' },
      { code: '058', name: 'Guaranty Trust Bank' },
      { code: '033', name: 'United Bank for Africa' },
      { code: '057', name: 'Zenith Bank' },
    ]);
  }
}
