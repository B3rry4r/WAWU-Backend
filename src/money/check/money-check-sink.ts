import {
  CHECK_IDS,
  type CheckId,
  type CheckState,
  type CheckSummary,
  type Finding,
  type Notice,
  REPORT_KEEP,
} from './money-check-types';

/**
 * Collects what the checks find. It keeps the first `REPORT_KEEP` mismatches
 * and the first `REPORT_KEEP` looks and counts the rest, so a night with a
 * hundred thousand differences still ends with a report that fits in a row
 * and an email, and says how many it left out.
 */
export class FindingSink {
  readonly mismatches: Finding[] = [];
  readonly look: Finding[] = [];
  readonly notices: Record<string, Notice> = {};
  private mismatchTotal = 0;
  private lookTotal = 0;
  private readonly mismatchesBy = new Map<CheckId, number>();
  private readonly looksBy = new Map<CheckId, number>();
  private readonly checked = new Map<CheckId, number>();
  private readonly states = new Map<CheckId, 'incomplete' | 'not_checked'>();
  private readonly notes = new Map<CheckId, string[]>();

  add(f: Finding): void {
    if (f.severity === 'mismatch') {
      this.mismatchTotal += 1;
      this.mismatchesBy.set(f.check, (this.mismatchesBy.get(f.check) ?? 0) + 1);
      if (this.mismatches.length < REPORT_KEEP) this.mismatches.push(f);
    } else {
      this.lookTotal += 1;
      this.looksBy.set(f.check, (this.looksBy.get(f.check) ?? 0) + 1);
      if (this.look.length < REPORT_KEEP) this.look.push(f);
    }
  }

  /**
   * `n` findings of this kind exist beyond the ones added: counted, not
   * kept, so the report can say how many it left out.
   */
  skipped(check: CheckId, severity: Finding['severity'], n: number): void {
    if (n <= 0) return;
    if (severity === 'mismatch') {
      this.mismatchTotal += n;
      this.mismatchesBy.set(check, (this.mismatchesBy.get(check) ?? 0) + n);
    } else {
      this.lookTotal += n;
      this.looksBy.set(check, (this.looksBy.get(check) ?? 0) + n);
    }
  }

  addAll(findings: readonly Finding[]): void {
    for (const f of findings) this.add(f);
  }

  /** `n` more things were compared by this check. */
  compared(check: CheckId, n: number): void {
    this.checked.set(check, (this.checked.get(check) ?? 0) + n);
  }

  /**
   * The check could not be made in full (`incomplete`) or at all
   * (`not_checked`). The worse of two states stands.
   */
  cannot(
    check: CheckId,
    state: 'incomplete' | 'not_checked',
    note: string,
  ): void {
    if (this.states.get(check) !== 'not_checked') this.states.set(check, state);
    const notes = this.notes.get(check) ?? [];
    if (!notes.includes(note)) notes.push(note);
    this.notes.set(check, notes);
  }

  notice(key: string, count: number, amountKobo?: bigint): void {
    if (count === 0) return;
    const n = (this.notices[key] ??= { count: 0 });
    n.count += count;
    if (amountKobo !== undefined) {
      n.amountKobo = (BigInt(n.amountKobo ?? '0') + amountKobo).toString();
    }
  }

  mergeNotices(from: Record<string, Notice>): void {
    for (const [key, n] of Object.entries(from)) {
      this.notice(
        key,
        n.count,
        n.amountKobo === undefined ? undefined : BigInt(n.amountKobo),
      );
    }
  }

  get mismatchCount(): number {
    return this.mismatchTotal;
  }

  get lookCount(): number {
    return this.lookTotal;
  }

  /** True when any check could not be made in full or at all. */
  get cannotCount(): number {
    return this.states.size;
  }

  get omitted(): { mismatches: number; look: number } {
    return {
      mismatches: this.mismatchTotal - this.mismatches.length,
      look: this.lookTotal - this.look.length,
    };
  }

  /** One summary per check, in the order of `CHECK_IDS`. */
  summaries(): CheckSummary[] {
    return CHECK_IDS.map((id) => {
      const mismatches = this.mismatchesBy.get(id) ?? 0;
      const looks = this.looksBy.get(id) ?? 0;
      const forced = this.states.get(id);
      let state: CheckState;
      if (mismatches > 0) state = 'differences';
      else if (forced !== undefined) state = forced;
      else if (looks > 0) state = 'needs_a_look';
      else state = 'ok';
      return {
        id,
        state,
        checked: this.checked.get(id) ?? 0,
        found: mismatches + looks,
        note: (this.notes.get(id) ?? []).join(' ') || null,
      };
    });
  }
}
