import type {
  ProviderCustomerLookup,
  ProviderCustomerMatch,
  ProviderCustomerSighting,
  ProviderIdentity,
  ProviderOpenedWallet,
  ProviderOpenWalletInput,
  ProviderPage,
  ProviderReviewState,
  WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import { toLocalNigerianPhone } from '../../wallet-provider/nigerian-phone';
import type { NuvionClient, NuvionOp } from '../nuvion-client';
import { maskNuvionText, NuvionError } from '../nuvion-error';
import { rejectNotSupported } from './not-supported';

const AREA = 'opening (NUV-02)';

/**
 * Bounds of the look for an entity after a create whose answer was lost,
 * and of the naira account lookup. Not fees, limits or promises: how much
 * of Nuvion's lists is read before the answer counts as "cannot tell".
 */
export const NUVION_OPENING_SEARCH = {
  /** Pages of 100 entities read before the list counts as too long to tell. */
  entityPages: 10,
  /** Entities made since the lost attempt that are read one by one. */
  entityReads: 20,
  /** Our clock and Nuvion's may differ by this much. */
  clockSkewMs: 5 * 60_000,
  /** Pages of 100 accounts read when looking for the naira account. */
  accountPages: 5,
} as const;

/** The naira account's label at Nuvion (`display_name`, at most 100). */
export const NAIRA_ACCOUNT_DISPLAY_NAME = 'Naira wallet';

const CREATE: NuvionOp = { name: 'create individual entity', call: 'write' };
const CORRECT: NuvionOp = { name: 'correct individual entity', call: 'write' };
const READ: NuvionOp = { name: 'read entity', call: 'read' };
const LIST: NuvionOp = { name: 'list entities', call: 'read' };
const OPEN_ACCOUNT: NuvionOp = { name: 'create naira account', call: 'write' };
const LIST_ACCOUNTS: NuvionOp = { name: 'list naira accounts', call: 'read' };

/** A Nuvion id we put in a path or a query: ULID-like, nothing else. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function idOf(v: unknown): string | null {
  return typeof v === 'string' && ID.test(v) ? v : null;
}

/** A status word as Nuvion writes them, lower case; null when none. */
function word(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const w = v.trim().toLowerCase();
  return /^[a-z][a-z0-9_ -]{0,39}$/.test(w) ? w : null;
}

/** Nuvion's times are Unix milliseconds. */
function millis(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

/** A phone as Nuvion holds it (`+234...`), in our E.164 form; null when unreadable. */
export function nuvionPhoneE164(phone: unknown): string | null {
  if (typeof phone !== 'string') return null;
  const local = toLocalNigerianPhone(phone);
  if (local !== null) return `+234${local.slice(1)}`;
  const d = phone.replace(/[\s\-()]/g, '');
  return /^\+\d{9,13}$/.test(d) ? d : null;
}

/**
 * Nuvion's own words, masked as the client masks them, and every run of
 * letters and digits holding 4 digits or more cut to its last 4: an ID
 * number (`AB1234567CD`) is masked like a BVN.
 */
export function maskReviewWords(text: string): string {
  return maskNuvionText(text).replace(/[A-Za-z0-9*]{6,}/g, (run) =>
    (run.match(/\d/g) ?? []).length >= 4
      ? `${'*'.repeat(run.length - 4)}${run.slice(-4)}`
      : run,
  );
}

/** Where Nuvion may put the reasons for a refusal (its docs name no field). */
const REASON_FIELDS = [
  'rejection_reason',
  'rejection_reasons',
  'rejection_feedback',
  'review_notes',
  'review_reason',
  'status_reason',
  'reasons',
] as const;

function reasonWords(from: unknown, into: string[]): void {
  if (!isRecord(from)) return;
  for (const field of REASON_FIELDS) {
    const v = from[field];
    const items = Array.isArray(v) ? v : [v];
    for (const item of items) {
      const text =
        typeof item === 'string'
          ? item
          : isRecord(item)
            ? [item.message, item.reason, item.description].find(
                (x): x is string => typeof x === 'string',
              )
            : undefined;
      if (text !== undefined && text.trim() !== '' && into.length < 5) {
        into.push(maskReviewWords(text.trim()).slice(0, 300));
      }
    }
  }
}

/**
 * One individual entity as Nuvion answered it, read field by field
 * (api-reference__entities.md: create, update and "Get an entity" answer
 * `entity`, `person` and `identification` side by side). The phone and the
 * email are read only to match an entity to the opening that made it; they
 * are never stored or logged. No BVN, NIN or document number is read: Nuvion
 * answers them masked and we keep only each one's `verification_status`.
 */
export interface NuvionEntityReading {
  entityId: string;
  /** `individual` or `business`; null when not given. */
  type: string | null;
  personId: string | null;
  /** Nuvion's review state, lower case (`incomplete` ... `suspended`). */
  status: string;
  /** When Nuvion made it (Unix ms); null when not given. */
  created: number | null;
  phone: string | null;
  email: string | null;
  bvnStatus: string | null;
  ninStatus: string | null;
  documentStatus: string | null;
  addressProofStatus: string | null;
  identificationStatus: string | null;
  /** Nuvion's own words for a refusal, masked; at most 5. */
  reasons: string[];
}

/** Reads `{ entity, person, identification }`, or the bare entity a webhook carries. */
export function readNuvionEntity(data: unknown): NuvionEntityReading | null {
  if (!isRecord(data)) return null;
  const entity = isRecord(data.entity) ? data.entity : data;
  const entityId = idOf(entity.id);
  const status = word(entity.status);
  if (entityId === null || status === null) return null;
  const person = isRecord(data.person) ? data.person : null;
  const identification = isRecord(data.identification)
    ? data.identification
    : null;
  const numbers = Array.isArray(identification?.identity_numbers)
    ? identification.identity_numbers.filter(isRecord)
    : [];
  const numberStatus = (type: string) =>
    word(
      numbers.find(
        (n) => typeof n.type === 'string' && n.type.toUpperCase() === type,
      )?.verification_status,
    );
  const doc = isRecord(identification?.document)
    ? identification.document
    : null;
  const poa = isRecord(identification?.proof_of_address)
    ? identification.proof_of_address
    : null;
  const reasons: string[] = [];
  const places = new Set<unknown>([entity, data, identification, doc, poa]);
  for (const from of places) reasonWords(from, reasons);
  const email =
    typeof person?.email === 'string'
      ? person.email.trim().toLowerCase()
      : null;
  return {
    entityId,
    type: word(entity.type),
    personId: idOf(person?.id) ?? idOf(entity.person_id),
    status,
    created: millis(entity.created),
    phone: nuvionPhoneE164(person?.phonenumber),
    email: email === '' ? null : email,
    bvnStatus: numberStatus('BVN'),
    ninStatus: numberStatus('NIN'),
    documentStatus: word(doc?.verification_status),
    addressProofStatus: word(poa?.verification_status),
    identificationStatus: word(identification?.verification_status),
    reasons: [...new Set(reasons)],
  };
}

/** The review the seam carries, from one reading. */
export function reviewStateOf(
  r: NuvionEntityReading,
  found: boolean,
): ProviderReviewState {
  return {
    personId: r.personId,
    status: r.status,
    bvnStatus: r.bvnStatus,
    ninStatus: r.ninStatus,
    documentStatus: r.documentStatus,
    addressProofStatus: r.addressProofStatus,
    identificationStatus: r.identificationStatus,
    reasons: r.reasons,
    found,
  };
}

/** The one naira account of an entity, as Nuvion lists or creates it. */
export interface NuvionNairaAccount {
  accountId: string;
  nuvionBan: string | null;
  currency: string;
  created: number | null;
}

function readAccount(v: unknown, entityId: string): NuvionNairaAccount | null {
  if (!isRecord(v)) return null;
  const accountId = idOf(v.id);
  const currency =
    typeof v.currency === 'string' ? v.currency.trim().toUpperCase() : '';
  const type = word(v.type);
  const owner = v.entity_id === undefined ? entityId : idOf(v.entity_id);
  const deleted = v.deleted === undefined || v.deleted === 0;
  if (accountId === null || owner !== entityId || !deleted) return null;
  if (currency !== 'NGN' || type !== 'checking') return null;
  const ban =
    typeof v.nuvion_ban === 'string' && /^[A-Za-z0-9]{1,40}$/.test(v.nuvion_ban)
      ? v.nuvion_ban
      : null;
  return { accountId, nuvionBan: ban, currency, created: millis(v.created) };
}

/** Nothing can be told about a lost create: never read as "none made". */
function unproven(why: string): NuvionError {
  return new NuvionError({
    kind: 'outcome_unknown',
    operation: 'find entity after a lost answer',
    messages: [why],
    recordMayExist: true,
  });
}

function refusedBeforeSending(operation: string, why: string): NuvionError {
  return new NuvionError({
    kind: 'validation',
    operation,
    messages: [why],
    recordMayExist: false,
  });
}

/**
 * Opening a wallet on Nuvion: the person as an individual entity with their
 * BVN and NIN, Nuvion's review, approved or rejected (task NUV-02, the
 * lead's scratchpad `nuvion/docs/core-concepts__entities.md`,
 * `api-reference__entities.md`, `api-reference__accounts.md`). This file is
 * NUV-02's alone: the adapter (nuvion-wallet-provider.ts) only delegates
 * here.
 *
 * - `openWallet` makes the entity (`POST /individual-entities`: `name`,
 *   `person` with the BVN and NIN, `address`, `identification`; no
 *   `entity_id`, since the entity is new) and answers `provisioning` with
 *   Nuvion's review, never `open`: the account comes after approval. With
 *   `review.customerId` it corrects that entity instead
 *   (`PATCH /individual-entities/{id}`, the child's `entity_id` in the
 *   body); with `review.lostAttemptAt` it first looks for the entity an
 *   earlier create whose answer was lost may have made (`GET /entities`,
 *   then each one made since, read back), and makes one only when Nuvion's
 *   list was read to its end without it.
 * - `readEntity` (`GET /entities/{id}`, the docs' advice: read the entity
 *   back before acting on a webhook), `findNairaAccount` (`GET /accounts`)
 *   and `openNairaAccount` (`POST /accounts`, one NGN `checking` account)
 *   are for the `entities.*` handler (src/nuvion/handlers/opening.handler.ts).
 * - `checkIdentity` stays `not_supported`: Nuvion has no standalone BVN
 *   lookup (capabilities.identityLookup is false); the BVN and NIN are
 *   checked inside Nuvion's review of the entity.
 * - Nuvion keeps no phone lookup and no customer list by page: under
 *   nuvion the opening answers "does this person have an entity?" from
 *   NuvionEntity (src/money/opening/), so `findCustomerByPhone` answers
 *   `unknown` (never "absent") and the two others `not_supported`.
 *
 * `submitKyc` (the onboarding submission) is NUV-03's, in documents.ts, and
 * `getWalletAccount` (the account number) NUV-04's, in accounts.ts.
 */
/** The WalletProvider methods this area answers for the adapter. */
export type NuvionOpeningMethods = Pick<
  WalletProvider,
  | 'checkIdentity'
  | 'openWallet'
  | 'findCustomerByPhone'
  | 'getCustomerMatch'
  | 'listCustomerSightings'
>;

export class NuvionOpeningArea implements NuvionOpeningMethods {
  constructor(readonly client: NuvionClient) {}

  checkIdentity(): Promise<ProviderIdentity> {
    return rejectNotSupported('check identity', AREA);
  }

  async openWallet(
    input: ProviderOpenWalletInput,
  ): Promise<ProviderOpenedWallet> {
    const review = input.review;
    if (!review) {
      throw refusedBeforeSending(
        CREATE.name,
        'the review details were not given; nothing was sent',
      );
    }
    const phone = nuvionPhoneE164(input.phone);
    if (phone === null) {
      throw refusedBeforeSending(CREATE.name, 'the phone is not readable');
    }
    if (review.customerId !== null) {
      const id = idOf(review.customerId);
      if (id === null) {
        throw refusedBeforeSending(CORRECT.name, 'not an entity id');
      }
      const answer = await this.client.patch(
        CORRECT,
        `/individual-entities/${encodeURIComponent(id)}`,
        {
          entity_id: id,
          ...this.entityBody(input, phone, review.numbersAgain),
        },
      );
      const read = readNuvionEntity(answer.data);
      if (read === null || read.entityId !== id) {
        throw new NuvionError({
          kind: 'not_confirmed',
          operation: CORRECT.name,
          httpStatus: answer.httpStatus,
          messages: ['the answer does not name the entity'],
          requestId: answer.requestId,
          recordMayExist: true,
        });
      }
      return this.provisioning(read, true);
    }
    if (review.lostAttemptAt !== null) {
      const found = await this.findMadeSince(
        input,
        phone,
        review.lostAttemptAt,
      );
      if (found !== null) return this.provisioning(found, true);
    }
    const answer = await this.client.post(
      CREATE,
      '/individual-entities',
      this.entityBody(input, phone, true),
    );
    const made = readNuvionEntity(answer.data);
    if (made === null) {
      throw new NuvionError({
        kind: 'not_confirmed',
        operation: CREATE.name,
        httpStatus: answer.httpStatus,
        messages: ['the answer carries no entity'],
        requestId: answer.requestId,
        recordMayExist: true,
      });
    }
    return this.provisioning(made, false);
  }

  /** Nuvion has no phone lookup: never "absent", so nothing is made on it. */
  findCustomerByPhone(): Promise<ProviderCustomerLookup> {
    return Promise.resolve({ state: 'unknown', why: 'empty_answer' });
  }

  getCustomerMatch(): Promise<ProviderCustomerMatch> {
    return rejectNotSupported('get customer match', AREA);
  }

  listCustomerSightings(): Promise<ProviderPage<ProviderCustomerSighting>> {
    return rejectNotSupported('list customer sightings', AREA);
  }

  /** `GET /entities/{id}`, the child's `entity_id` as the query. */
  async readEntity(entityId: string): Promise<NuvionEntityReading> {
    const id = idOf(entityId);
    if (id === null) throw refusedBeforeSending(READ.name, 'not an entity id');
    const answer = await this.client.get(
      READ,
      `/entities/${encodeURIComponent(id)}`,
      { entity_id: id },
    );
    const read = readNuvionEntity(answer.data);
    if (read === null || read.entityId !== id) {
      throw new NuvionError({
        kind: 'bad_response',
        operation: READ.name,
        httpStatus: answer.httpStatus,
        messages: ['the answer does not name the entity asked for'],
        requestId: answer.requestId,
      });
    }
    return read;
  }

  /**
   * The entity's NGN checking account, from `GET /accounts` read to its
   * end (the earliest when there are several); null when it has none. A
   * list longer than we read is `unavailable`: never read as "none".
   */
  async findNairaAccount(entityId: string): Promise<NuvionNairaAccount | null> {
    const id = idOf(entityId);
    if (id === null) {
      throw refusedBeforeSending(LIST_ACCOUNTS.name, 'not an entity id');
    }
    const listed = await this.client.listAll<unknown>(
      LIST_ACCOUNTS,
      '/accounts',
      { entity_id: id, currency: 'NGN', type: 'checking', limit: 100 },
      { maxPages: NUVION_OPENING_SEARCH.accountPages },
    );
    if (!listed.complete) {
      throw new NuvionError({
        kind: 'unavailable',
        operation: LIST_ACCOUNTS.name,
        messages: ['the account list is longer than read'],
      });
    }
    const accounts = listed.items
      .map((a) => readAccount(a, id))
      .filter((a): a is NuvionNairaAccount => a !== null)
      .sort((a, b) => (a.created ?? 0) - (b.created ?? 0));
    return accounts[0] ?? null;
  }

  /** `POST /accounts`: one NGN `checking` account for an approved entity. */
  async openNairaAccount(entityId: string): Promise<NuvionNairaAccount> {
    const id = idOf(entityId);
    if (id === null) {
      throw refusedBeforeSending(OPEN_ACCOUNT.name, 'not an entity id');
    }
    const answer = await this.client.post(OPEN_ACCOUNT, '/accounts', {
      entity_id: id,
      type: 'checking',
      currency: 'NGN',
      display_name: NAIRA_ACCOUNT_DISPLAY_NAME,
    });
    const data = answer.data;
    const account = readAccount(
      isRecord(data) && isRecord(data.account) ? data.account : data,
      id,
    );
    if (account === null) {
      throw new NuvionError({
        kind: 'not_confirmed',
        operation: OPEN_ACCOUNT.name,
        httpStatus: answer.httpStatus,
        messages: ['the answer carries no NGN checking account'],
        requestId: answer.requestId,
        recordMayExist: true,
      });
    }
    return account;
  }

  // -------------------------------------------------------------------------

  private provisioning(
    r: NuvionEntityReading,
    found: boolean,
  ): ProviderOpenedWallet {
    return {
      state: 'provisioning',
      customerId: r.entityId,
      walletId: null,
      review: reviewStateOf(r, found),
    };
  }

  /**
   * The entity's body, field by field from the docs' "Create an individual
   * entity". The BVN and NIN go on a create, and on a correction only when
   * the review named one of them (`numbersAgain`); an ID of type
   * `national_id` is Nigeria's NIN slip (`id_subtype` NIN).
   */
  private entityBody(
    input: ProviderOpenWalletInput,
    phone: string,
    numbers: boolean,
  ): Record<string, unknown> {
    const r = input.review!;
    const person: Record<string, unknown> = {
      first_name: input.firstName,
      last_name: input.lastName,
      date_of_birth: input.dateOfBirth,
      email: input.email,
      nationality: r.nationality,
      gender: r.gender === 'male' ? 'm' : 'f',
      phonenumber: phone,
    };
    if (r.middleName) person.middle_name = r.middleName;
    if (numbers) {
      person.bvn = input.bvn;
      person.nin = input.nin;
    }
    const address: Record<string, unknown> = {
      line_1: r.address.line1,
      city: r.address.city,
      state: r.address.state,
      postal_code: r.address.postalCode,
      country_code: r.address.countryCode,
    };
    if (r.address.line2) address.line_2 = r.address.line2;
    const document: Record<string, unknown> = {
      type: r.idDocument.type,
      number: r.idDocument.number,
      issuing_country: r.idDocument.issuingCountry,
    };
    if (r.idDocument.issueDate) document.issue_date = r.idDocument.issueDate;
    if (r.idDocument.expiryDate) document.expiry_date = r.idDocument.expiryDate;
    if (r.idDocument.type === 'national_id') {
      document.type_specific = { id_subtype: 'NIN' };
    }
    return {
      name: `${input.firstName} ${input.lastName}`.slice(0, 255),
      person,
      address,
      identification: {
        document,
        proof_of_address: { type: r.proofOfAddressType },
      },
    };
  }

  /**
   * After a create whose answer was lost: the entity it may have made.
   * Nuvion's entity list (`GET /entities?name=`, the call Nuvion's own
   * dashboard makes; not yet in its public docs) is read to its end; each
   * entity made since the lost attempt (less the clock skew) is read back
   * and is this person's only when its phone and email are the ones sent.
   * Null only when the whole list was read and none is; anything else
   * (the list unreadable, refused or too long, a read that fails) is
   * `outcome_unknown`, so the opening waits and nothing is made.
   */
  private async findMadeSince(
    input: ProviderOpenWalletInput,
    phone: string,
    since: Date,
  ): Promise<NuvionEntityReading | null> {
    let listed: { items: unknown[]; complete: boolean };
    try {
      listed = await this.client.listAll<unknown>(
        LIST,
        '/entities',
        { name: `${input.firstName} ${input.lastName}`, limit: 100 },
        { maxPages: NUVION_OPENING_SEARCH.entityPages },
      );
    } catch {
      throw unproven('the entity list could not be read');
    }
    if (!listed.complete) throw unproven('the entity list is longer than read');
    const after = since.getTime() - NUVION_OPENING_SEARCH.clockSkewMs;
    const candidates = listed.items
      .filter(isRecord)
      .filter((e) => {
        const created = millis(e.created);
        const type = word(e.type);
        return (
          idOf(e.id) !== null &&
          (type === null || type === 'individual') &&
          (created === null || created >= after)
        );
      })
      .map((e) => idOf(e.id)!);
    if (candidates.length > NUVION_OPENING_SEARCH.entityReads) {
      throw unproven('too many entities made since the lost attempt');
    }
    const email = input.email.trim().toLowerCase();
    for (const id of candidates) {
      let read: NuvionEntityReading;
      try {
        read = await this.readEntity(id);
      } catch {
        throw unproven('an entity made since could not be read');
      }
      if (read.phone === phone && read.email === email) return read;
    }
    return null;
  }
}
