import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  WawuIdDeadline,
  wawuIdExchange,
  wawuIdTimeoutMs,
} from '../common/auth/wawu-id-exchange';

/** The ids WAWU ID takes in one `ids` read (its own bound). */
export const WAWU_ID_USERS_MAX_IDS = 200;
/** The most one search page returns (its own bound). */
export const WAWU_ID_USERS_MAX_LIMIT = 100;

/** One person as WAWU ID's `POST /internal/users/list` answers. */
export interface WawuIdUser {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  countryCode: string | null;
  createdAt: string | null;
  emailVerified: boolean;
  phoneVerified: boolean;
}

export interface WawuIdUsersPage {
  items: WawuIdUser[];
  nextCursor: string | null;
}

/** The dev fallback is a public string: production must not run on it (the same rule the other WAWU ID clients keep). */
function resolveServiceKey(configured: string | undefined): string {
  if (configured) return configured;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'WAWU_ID_INTERNAL_SERVICE_KEY is not set. Refusing to start in production with the public development fallback.',
    );
  }
  return 'dev-internal-service-key-not-secret';
}

const text = (v: unknown): string | null =>
  typeof v === 'string' && v !== '' ? v : null;

function toUser(row: unknown): WawuIdUser | null {
  if (typeof row !== 'object' || row === null) return null;
  const r = row as Record<string, unknown>;
  const id = text(r.id);
  if (id === null) return null;
  return {
    id,
    firstName: text(r.firstName),
    lastName: text(r.lastName),
    email: text(r.email),
    phone: text(r.phone),
    countryCode: text(r.countryCode),
    createdAt: text(r.createdAt),
    emailVerified: r.emailVerified === true,
    phoneVerified: r.phoneVerified === true,
  };
}

/**
 * WAWU ID's read of its people (`POST <WAWU ID>/internal/users/list`), for the
 * dashboard's user list and the country fill (R-142, R-143).
 *
 * Same base URL, service key and bounded exchange as WawuIdClient and the
 * other WAWU ID calls; nothing new in the environment. `src/common/**` is
 * fenced, so the method lives here and not on WawuIdClient.
 *
 * A read that does not work (WAWU ID down, slow, the route not live yet, an
 * answer in another shape) is `null`, never a throw: every caller has a way to
 * go on without it. What comes back is a name, an email or a phone, so it is
 * never logged, and the logs here carry a status and nothing else.
 */
@Injectable()
export class WawuIdUsersClient {
  private readonly logger = new Logger(WawuIdUsersClient.name);
  private readonly baseUrl: string;
  private readonly serviceKey: string;
  private readonly readMs: number;

  constructor(private readonly config: ConfigService) {
    this.baseUrl =
      this.config.get<string>('WAWU_ID_BASE_URL') ?? 'http://localhost:4001';
    this.serviceKey = resolveServiceKey(
      this.config.get<string>('WAWU_ID_INTERNAL_SERVICE_KEY'),
    );
    this.readMs = wawuIdTimeoutMs(this.config, 'read');
  }

  /** Exactly those of `ids` WAWU ID has (at most 200 per call), or null when it could not answer. */
  async byIds(ids: string[]): Promise<Map<string, WawuIdUser> | null> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    if (unique.length > WAWU_ID_USERS_MAX_IDS) {
      throw new RangeError(
        `WAWU ID reads at most ${WAWU_ID_USERS_MAX_IDS} ids at a time`,
      );
    }
    const page = await this.call({ ids: unique });
    if (page === null) return null;
    return new Map(page.items.map((u) => [u.id, u]));
  }

  /** One page of a search, newest first, or null when WAWU ID could not answer. */
  search(
    q: string,
    cursor?: string | null,
    limit: number = WAWU_ID_USERS_MAX_LIMIT,
  ): Promise<WawuIdUsersPage | null> {
    return this.call({
      q,
      ...(cursor ? { cursor } : {}),
      limit: Math.min(limit, WAWU_ID_USERS_MAX_LIMIT),
    });
  }

  private async call(body: object): Promise<WawuIdUsersPage | null> {
    const deadline = new WawuIdDeadline(
      'users list',
      this.readMs,
      'WAWU ID did not answer the users list in time.',
    );
    try {
      const res = await wawuIdExchange(
        `${this.baseUrl}/internal/users/list`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Service-Key': this.serviceKey,
          },
          body: JSON.stringify(body),
        },
        deadline,
      );
      if (!res.ok) {
        this.logger.warn(`WAWU ID users list failed (HTTP ${res.status})`);
        return null;
      }
      const parsed = JSON.parse(res.text) as unknown;
      const root =
        typeof parsed === 'object' && parsed !== null
          ? (parsed as Record<string, unknown>)
          : {};
      // The contract is `{ items, nextCursor }`; a `data` wrapper (the shape
      // `internal/users/lookup` answers in) is read the same way.
      const inner =
        !Array.isArray(root.items) &&
        typeof root.data === 'object' &&
        root.data !== null
          ? (root.data as Record<string, unknown>)
          : root;
      if (!Array.isArray(inner.items)) {
        this.logger.warn('WAWU ID users list answered in an unknown shape');
        return null;
      }
      const items: WawuIdUser[] = [];
      for (const row of inner.items) {
        const u = toUser(row);
        if (u) items.push(u);
      }
      return { items, nextCursor: text(inner.nextCursor) };
    } catch (error) {
      this.logger.warn(
        `WAWU ID users list did not answer (${error instanceof Error ? error.name : 'error'})`,
      );
      return null;
    } finally {
      deadline.end();
    }
  }
}
