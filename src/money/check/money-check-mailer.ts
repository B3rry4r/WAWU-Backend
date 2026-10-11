import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MoneyCheckReport } from './money-check-types';
import { REPORT_MAIL } from './money-check-types';

/**
 * What WAWU ID is handed to write the night's email from: counts, the
 * references a person looks at and the kobo amounts. Never a name, a phone
 * number or an account number. WAWU ID owns the address, the subject and the
 * wording; the Hub only names the person and gives the facts. WAWU ID refuses
 * a body with any other field or any character it does not expect (its
 * `parseMoneyCheckReport`), so this shape is the whole of what is sent.
 */
export interface MoneyCheckMail {
  night: string;
  provider: string;
  verdict: MoneyCheckReport['verdict'];
  ranAt: string;
  walletsTotal: number;
  walletsChecked: number;
  mismatchCount: number;
  lookCount: number;
  checks: Array<{
    id: string;
    state: string;
    checked: number;
    found: number;
    note: string | null;
  }>;
  held: MoneyCheckReport['held'];
  items: Array<{
    check: string;
    severity: string;
    kind: string;
    ref: string;
    detail: string;
    amountKobo?: string;
    otherKobo?: string;
  }>;
  /** Findings that are in the stored report and not in `items`. */
  itemsOmitted: number;
  notices: MoneyCheckReport['notices'];
}

/**
 * WAWU ID takes a sentence made of letters, digits, spaces and `. , : ; ' " (
 * ) _ -` only, and a reference made of letters, digits and `. _ : -` only, and
 * refuses the whole report otherwise (a report with a stray character must
 * not be lost, so the Hub sends only what WAWU ID accepts). The stored report
 * keeps the text as the check wrote it.
 */
const UNSAFE_IN_SENTENCE = /[^A-Za-z0-9 .,:;'"()_-]/g;
const UNSAFE_IN_REF = /[^A-Za-z0-9._:-]/g;

export function plainSentence(text: string, max: number): string {
  const t = text
    .replace(UNSAFE_IN_SENTENCE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
  return t === '' ? 'No details.' : t;
}

/**
 * A reference as WAWU ID takes it. A reference that is only 10 or 11 digits
 * (or 234 and ten more) looks like a phone, account or ID number and is
 * refused there, so it is sent with a word in front of it.
 */
export function plainRef(text: string): string {
  let t = text.replace(UNSAFE_IN_REF, '_').slice(0, 80);
  if (!/^[A-Za-z0-9]/.test(t)) t = `r${t}`;
  if (/^(?:\d{10,11}|234\d{10})$/.test(t.replace(/[._:-]/g, ''))) {
    t = `ref-${t}`;
  }
  return t.slice(0, 80);
}

/** The mail a report is made into: mismatches first, then what to look at. */
export function mailOf(
  report: MoneyCheckReport,
  counts: { mismatchCount: number; lookCount: number },
): MoneyCheckMail {
  const all = [...report.mismatches, ...report.look];
  const items = all.slice(0, REPORT_MAIL).map((f) => ({
    check: f.check,
    severity: f.severity,
    kind: f.kind,
    ref: plainRef(f.ref),
    detail: plainSentence(f.detail, 400),
    ...(f.amountKobo === undefined ? {} : { amountKobo: f.amountKobo }),
    ...(f.otherKobo === undefined ? {} : { otherKobo: f.otherKobo }),
  }));
  return {
    night: report.night,
    provider: report.provider,
    verdict: report.verdict,
    ranAt: report.finishedAt,
    walletsTotal: report.wallets.total,
    walletsChecked: report.wallets.checked,
    mismatchCount: counts.mismatchCount,
    lookCount: counts.lookCount,
    checks: report.checks.map((c) => ({
      id: c.id,
      state: c.state,
      checked: c.checked,
      found: c.found,
      note: c.note === null ? null : plainSentence(c.note, 1000),
    })),
    held: report.held,
    items,
    itemsOmitted: counts.mismatchCount + counts.lookCount - items.length,
    notices: report.notices,
  };
}

/**
 * WAWU ID would not take the report, or could not be reached. The message is
 * ours (a status code, no body text) and goes to the Hub's log only.
 */
export class MoneyCheckMailRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyCheckMailRefused';
  }
}

/**
 * Asks WAWU ID to email the nightly check's report to one person (task
 * MONEY-16), the way the data-export link and the PIN reset code are: the
 * Hub names the user and gives the facts, WAWU ID owns the address and the
 * wording (it is deliberately not a mail relay, so the Hub never sends an
 * address or a body). `POST /internal/users/:userId/money-check-report` with
 * the `X-Service-Key`; WAWU ID's route is BACKEND_GAPS G-690, built in
 * wawu-id on `wmt/MONEY-16`. It answers 200 `{ data: { emailed: true } }`
 * once the mail is handed to its mailer, and 404 (no such person), 409 (no
 * verified address), 400 (a body it will not take) or 503 (the mailer is
 * down) otherwise. Anything but an `emailed` answer leaves the report unsent:
 * the run keeps it and the sweep tries again.
 */
@Injectable()
export class MoneyCheckMailer {
  constructor(private readonly config: ConfigService) {}

  async send(wawuUserId: string, mail: MoneyCheckMail): Promise<void> {
    const base =
      this.config.get<string>('WAWU_ID_BASE_URL') ?? 'http://localhost:4001';
    const serviceKey =
      this.config.get<string>('WAWU_ID_INTERNAL_SERVICE_KEY') ??
      (process.env.NODE_ENV === 'production'
        ? undefined
        : 'dev-internal-service-key-not-secret');
    if (!serviceKey) {
      throw new MoneyCheckMailRefused(
        'WAWU_ID_INTERNAL_SERVICE_KEY is not set.',
      );
    }
    const res = await fetch(
      `${base}/internal/users/${encodeURIComponent(wawuUserId)}/money-check-report`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Service-Key': serviceKey,
        },
        body: JSON.stringify(mail),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!res.ok) {
      throw new MoneyCheckMailRefused(
        `WAWU ID refused the money check report (HTTP ${res.status}).`,
      );
    }
    // A 200 that says nothing was sent (no address to send to) is not taken.
    const answer = (await res.json().catch(() => null)) as {
      data?: { emailed?: unknown; sent?: unknown };
    } | null;
    if (answer?.data?.emailed === false || answer?.data?.sent === false) {
      throw new MoneyCheckMailRefused(
        'WAWU ID took the money check report and sent no mail.',
      );
    }
  }
}
