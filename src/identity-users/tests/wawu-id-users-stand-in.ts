import type { WawuIdUser, WawuIdUsersPage } from '../wawu-id-users.client';

/**
 * A stand-in for WAWU ID's `POST /internal/users/list`, for specs (the way the
 * repo's other WAWU ID calls are stood in for: the class is replaced with
 * `overrideProvider`). It answers the contract the route is built to: `ids`
 * gives exactly those that exist; `q` matches part of a name, a whole email or
 * a whole phone in any usual form, newest first, paged by `cursor`.
 */
export class WawuIdUsersStandIn {
  users = new Map<string, WawuIdUser>();
  /** When true every call is "WAWU ID cannot be reached" (null). */
  down = false;
  /** Each call as it was made: `ids` batches and the `q` text, for assertions. */
  idCalls: string[][] = [];
  searchCalls: Array<{ q: string; cursor: string | null }> = [];

  add(u: Partial<WawuIdUser> & { id: string }): void {
    this.users.set(u.id, {
      firstName: null,
      lastName: null,
      email: null,
      phone: null,
      countryCode: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      emailVerified: false,
      phoneVerified: false,
      ...u,
    });
  }

  async byIds(ids: string[]): Promise<Map<string, WawuIdUser> | null> {
    this.idCalls.push([...ids]);
    if (this.down) return null;
    const out = new Map<string, WawuIdUser>();
    for (const id of ids) {
      const u = this.users.get(id);
      if (u) out.set(id, u);
    }
    return out;
  }

  async search(
    q: string,
    cursor?: string | null,
    limit = 100,
  ): Promise<WawuIdUsersPage | null> {
    this.searchCalls.push({ q, cursor: cursor ?? null });
    if (this.down) return null;
    const needle = q.trim().toLowerCase();
    const digits = needle.replace(/\D/g, '');
    const national = digits.startsWith('0') ? `234${digits.slice(1)}` : digits;
    const hits = [...this.users.values()]
      .filter((u) => {
        const name = `${u.firstName ?? ''} ${u.lastName ?? ''}`.toLowerCase();
        const phone = (u.phone ?? '').replace(/\D/g, '');
        return (
          name.includes(needle) ||
          (u.email ?? '').toLowerCase() === needle ||
          (digits.length >= 7 && phone === national)
        );
      })
      .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
    const start = cursor ? Number(cursor) : 0;
    const items = hits.slice(start, start + limit);
    const next = start + limit < hits.length ? String(start + limit) : null;
    return { items, nextCursor: next };
  }
}
