import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  Bank,
  FlutterwaveWalletGateway,
  PsaBalance,
  PsaWallet,
  ResolvedAccount,
  TransferResult,
} from './flutterwave-wallet.gateway';

const BASE = 'https://api.flutterwave.com/v3';

interface FlwEnvelope<T> {
  status: string;
  message: string;
  data: T;
}

/**
 * The real Flutterwave calls behind creator wallets.
 *
 * Every wallet here is a PAYOUT SUBACCOUNT: an account at Flutterwave MFB in
 * the creator's name, holding NGN, under Flutterwave's own banking licence.
 * WAWU instructs; Flutterwave custodies. Nothing in this file ever holds a
 * balance of its own.
 */
@Injectable()
export class FlutterwaveWalletClient implements FlutterwaveWalletGateway {
  private readonly logger = new Logger(FlutterwaveWalletClient.name);
  private readonly secret: string;

  constructor(config: ConfigService) {
    this.secret = config.get<string>('FLUTTERWAVE_SECRET_KEY') ?? '';
  }

  private async call<T>(
    path: string,
    init: { method: string; body?: unknown },
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${BASE}${path}`, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${this.secret}`,
          'Content-Type': 'application/json',
        },
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      });
    } catch (e) {
      // A network failure is NOT evidence about the money. Say so plainly so
      // callers never record a movement they cannot prove happened.
      throw new ServiceUnavailableException(
        `Could not reach Flutterwave: ${(e as Error).message}`,
      );
    }

    const text = await res.text();
    let json: FlwEnvelope<T> | null = null;
    try {
      json = JSON.parse(text) as FlwEnvelope<T>;
    } catch {
      /* handled below */
    }

    if (!res.ok || !json || json.status !== 'success') {
      const detail = json?.message ?? text.slice(0, 200);
      this.logger.error(`Flutterwave ${init.method} ${path} -> ${res.status}: ${detail}`);
      throw new ServiceUnavailableException(`Flutterwave refused that: ${detail}`);
    }
    return json.data;
  }

  async createWallet(input: {
    accountName: string;
    email: string;
    country: string;
    mobilenumber?: string;
  }): Promise<PsaWallet> {
    const d = await this.call<{
      account_reference: string;
      barter_id: string;
      nuban?: string;
      bank_name?: string;
      bank_code?: string;
      status?: string;
    }>('/payout-subaccounts', {
      method: 'POST',
      body: {
        account_name: input.accountName,
        email: input.email,
        country: input.country,
        ...(input.mobilenumber ? { mobilenumber: input.mobilenumber } : {}),
      },
    });
    return {
      accountReference: d.account_reference,
      barterId: d.barter_id,
      nuban: d.nuban ?? null,
      bankName: d.bank_name ?? null,
      bankCode: d.bank_code ?? null,
      status: d.status ?? 'ACTIVE',
    };
  }

  async balance(accountReference: string): Promise<PsaBalance> {
    const d = await this.call<
      { available_balance?: number; currency?: string } | Array<{ available_balance?: number; currency?: string }>
    >(`/payout-subaccounts/${encodeURIComponent(accountReference)}/balances`, {
      method: 'GET',
    });
    // Flutterwave has returned this as both an object and a one-element array
    // depending on the account. Handle both rather than trusting one shape.
    const row = Array.isArray(d) ? d[0] : d;
    return { availableNgn: Math.floor(Number(row?.available_balance ?? 0)) };
  }

  async fundWallet(input: {
    barterId: string;
    amount: number;
    reference: string;
    narration: string;
  }): Promise<TransferResult> {
    // account_bank "flutterwave" with the barter id is the documented way to
    // move money between WAWU's balance and a payout subaccount.
    const d = await this.call<{ id: number | string; status: string }>('/transfers', {
      method: 'POST',
      body: {
        account_bank: 'flutterwave',
        account_number: input.barterId,
        amount: input.amount,
        currency: 'NGN',
        narration: input.narration,
        reference: input.reference,
      },
    });
    return { transferId: String(d.id), status: d.status };
  }

  async withdraw(input: {
    accountReference: string;
    bankCode: string;
    accountNumber: string;
    amount: number;
    reference: string;
    narration: string;
  }): Promise<TransferResult> {
    const d = await this.call<{ id: number | string; status: string }>('/transfers', {
      method: 'POST',
      body: {
        account_bank: input.bankCode,
        account_number: input.accountNumber,
        amount: input.amount,
        currency: 'NGN',
        narration: input.narration,
        reference: input.reference,
        debit_currency: 'NGN',
        // THE FIELD THAT MAKES THIS THE CREATOR'S MONEY AND NOT OURS. Without
        // debit_subaccount the transfer comes out of WAWU's main balance.
        debit_subaccount: input.accountReference,
      },
    });
    return { transferId: String(d.id), status: d.status };
  }

  async resolveAccount(bankCode: string, accountNumber: string): Promise<ResolvedAccount> {
    const d = await this.call<{ account_number: string; account_name: string }>(
      '/accounts/resolve',
      {
        method: 'POST',
        body: { account_bank: bankCode, account_number: accountNumber },
      },
    );
    return { accountNumber: d.account_number, accountName: d.account_name };
  }

  async banks(): Promise<Bank[]> {
    const d = await this.call<Array<{ code: string; name: string }>>('/banks/NG', {
      method: 'GET',
    });
    return d
      .map((b) => ({ code: b.code, name: b.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}
