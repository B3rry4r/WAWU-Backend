import { randomUUID } from 'node:crypto';
import {
  envelope,
  errorBody,
  type NuvionStandin,
  type StandinAnswer,
  type StandinRequest,
} from './nuvion-standin';

/**
 * Nuvion's entities, documents, onboarding submissions and hosted selfie as
 * a stateful double on NUV-01's stand-in (task NUV-03), built from the docs'
 * own examples: `POST /documents` (api-reference__entities.md, "Upload a KYC
 * document"), `POST /onboarding-submissions` ("Submit for onboarding
 * review"), `GET /entities/{id}` with its `documents` list, and, from
 * Nuvion's dashboard code (SANDBOX-FINDINGS item 4), `POST
 * /kyc/liveness/sessions`, `GET /kyc/liveness/sessions/{id}` and the
 * `meta.liveness_check_id` PATCH. Nothing leaves this machine.
 *
 * Switches are plain fields the spec sets; each acts on the next request
 * that reaches the route it names.
 */

export interface HeldDocument {
  id: string;
  key: string;
  created: number;
  fileType: string;
  hasBack: boolean;
  personId: string | null;
  /** Bytes of the base64 the stand-in received; the content itself is not kept. */
  fileChars: number;
}

export interface HeldEntity {
  id: string;
  personId: string;
  status: string;
  phone: string;
  email: string;
  created: number;
  documents: HeldDocument[];
  meta: Record<string, unknown>;
  documentStatus: string;
  addressProofStatus: string;
  submissions: number;
}

export interface HeldSession {
  id: string;
  entityId: string | null;
  redirectUrl: string | null;
  captureStatus: string;
  verificationStatus: string;
  initiatedAt: number;
  url: string;
}

export type UploadMode =
  | 'ok'
  /** Made at once, the answer arrives after `lateMs`. */
  | 'late'
  /** Made, then a 500. */
  | 'made_then_500'
  /** A 500 before anything is made. */
  | 'nothing_then_500'
  | { refuse: string; status?: number };

export type SubmitMode =
  | 'ok'
  | 'late'
  | 'made_then_500'
  | 'nothing_then_500'
  | { refuse: string; status?: number };

export type SessionMode =
  'ok' | { refuse: string; status?: number } | 'late' | 'nothing_then_500';

export class DocumentsNuvion {
  readonly entities = new Map<string, HeldEntity>();
  readonly sessions = new Map<string, HeldSession>();
  uploadMode: UploadMode = 'ok';
  submitMode: SubmitMode = 'ok';
  sessionMode: SessionMode = 'ok';
  /** The PATCH that saves `meta.liveness_check_id` answers this instead of 200. */
  linkRefuse: { refuse: string; status?: number } | null = null;
  /** What a submission moves an entity to (`pending`, or a decision at once). */
  submitStatus = 'pending';
  /** When set, `GET /entities` hides the documents (so a lost upload cannot be found). */
  hideDocuments = false;
  /** Milliseconds a `late` answer waits. */
  lateMs = 2_000;
  /** Milliseconds every `POST /documents` waits before it answers (overlap tests). */
  uploadDelayMs = 0;

  constructor(private readonly standin: NuvionStandin) {}

  /** Registers the routes. Call after `standin.reset()`, before the requests. */
  install(): void {
    const s = this.standin;
    s.on('POST', '/documents', (req) => this.upload(req));
    s.on('POST', '/onboarding-submissions', (req) => this.submit(req));
    s.on('GET', /^\/entities\/[^/]+$/, (req) => this.getEntity(req));
    s.on('PATCH', /^\/individual-entities\/[^/]+$/, (req) =>
      this.patchEntity(req),
    );
    s.on('POST', '/kyc/liveness/sessions', (req) => this.startSession(req));
    s.on('GET', /^\/kyc\/liveness\/sessions\/[^/]+$/, (req) =>
      this.getSession(req),
    );
  }

  reset(): void {
    this.entities.clear();
    this.sessions.clear();
    this.uploadMode = 'ok';
    this.submitMode = 'ok';
    this.sessionMode = 'ok';
    this.linkRefuse = null;
    this.submitStatus = 'pending';
    this.hideDocuments = false;
    this.uploadDelayMs = 0;
  }

  addEntity(over: Partial<HeldEntity> = {}): HeldEntity {
    const e: HeldEntity = {
      id: ulid('01ENT'),
      personId: ulid('01PER'),
      status: 'incomplete',
      phone: '+2348000000000',
      email: 'person@example.com',
      created: Date.now(),
      documents: [],
      meta: {},
      documentStatus: 'pending',
      addressProofStatus: 'pending',
      submissions: 0,
      ...over,
    };
    this.entities.set(e.id, e);
    return e;
  }

  /** The documents of this kind Nuvion holds for the entity. */
  docs(entityId: string, key?: string): HeldDocument[] {
    return (this.entities.get(entityId)?.documents ?? []).filter(
      (d) => key === undefined || d.key === key,
    );
  }

  // -------------------------------------------------------------------------

  private entityJson(e: HeldEntity) {
    return {
      entity: {
        id: e.id,
        type: 'individual',
        status: e.status,
        name: 'Test Person',
        is_root: false,
        parent_entity: '01HXYZ1234ABCDEFGHJKMNPQRS',
        person_id: e.personId,
        user_id: '01HXYZ0003ABCDEFGHJKMNPQRS',
        creation_context: 'api',
        created: e.created,
        updated: Date.now(),
      },
      person: {
        id: e.personId,
        first_name: 'Test',
        last_name: 'Person',
        email: e.email,
        nationality: 'NG',
        gender: 'f',
        is_pep: false,
        status: 'approved',
        phonenumber: e.phone,
      },
      identification: {
        id: ulid('01IDN'),
        person_id: e.personId,
        verification_status: e.status === 'approved' ? 'approved' : 'pending',
        document: {
          type: 'international_passport',
          number: '***1234',
          verification_status: e.documentStatus,
        },
        proof_of_address: {
          type: 'utility_bill',
          verification_status: e.addressProofStatus,
        },
        identity_numbers: [
          { type: 'BVN', value: '***5678', verification_status: 'pending' },
          { type: 'NIN', value: '***9012', verification_status: 'pending' },
        ],
      },
      person_meta: { person_id: e.personId, meta: e.meta },
      documents: this.hideDocuments
        ? []
        : e.documents.map((d) => ({
            id: d.id,
            key: d.key,
            description: d.key === 'identity' ? 'Identity document' : 'Proof',
            urls: {
              main: `https://files.example.invalid/entity-documents/${e.id}/${d.id}`,
            },
            meta: { file_type: d.fileType, content_hash: 'x'.repeat(64) },
            created: d.created,
            updated: d.created,
          })),
      child_entities: [],
    };
  }

  private fail(
    mode: { refuse: string; status?: number },
    message = 'Refused.',
  ): StandinAnswer {
    return {
      status: mode.status ?? 422,
      body: errorBody(mode.refuse, message),
    };
  }

  private upload(req: StandinRequest): StandinAnswer {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const mode = this.uploadMode;
    if (typeof mode === 'object') return this.fail(mode);
    if (mode === 'nothing_then_500') {
      return { status: 500, body: errorBody('error_system_internal_error') };
    }
    const entity = this.entities.get(String(b.entity_id));
    if (!entity) {
      return {
        status: 404,
        body: errorBody('error_resource_not_found', 'Resource does not exist'),
      };
    }
    const link = (b.link_to_identity ?? {}) as { person_id?: string };
    const meta = (b.meta ?? {}) as { file_type?: string };
    const doc: HeldDocument = {
      id: ulid('01DOC'),
      key: String(b.key),
      created: Date.now(),
      fileType: String(meta.file_type ?? ''),
      hasBack: typeof b.file_back === 'string',
      personId: link.person_id ?? null,
      fileChars: typeof b.file === 'string' ? b.file.length : 0,
    };
    entity.documents.push(doc);
    const body = envelope(
      {
        document: {
          id: doc.id,
          entity_id: entity.id,
          key: doc.key,
          description: String(b.description ?? ''),
          urls: {
            main: `https://files.example.invalid/entity-documents/${entity.id}/${doc.id}`,
          },
          meta: {
            file_type: doc.fileType,
            verification_status: 'pending',
            uploaded_at: doc.created,
          },
          created: doc.created,
          updated: doc.created,
        },
        entity_verification_impact: { entity_id: entity.id },
      },
      'Document submitted successfully',
    );
    const delayMs = this.uploadDelayMs || undefined;
    if (mode === 'made_then_500') {
      return {
        status: 500,
        body: errorBody('error_system_internal_error'),
        delayMs,
      };
    }
    if (mode === 'late') return { status: 201, body, delayMs: this.lateMs };
    return { status: 201, body, delayMs };
  }

  private submit(req: StandinRequest): StandinAnswer {
    const b = (req.body ?? {}) as { entity_id?: string };
    const mode = this.submitMode;
    if (typeof mode === 'object') return this.fail(mode);
    if (mode === 'nothing_then_500') {
      return { status: 500, body: errorBody('error_system_internal_error') };
    }
    const entity = this.entities.get(String(b.entity_id));
    if (!entity) {
      return {
        status: 404,
        body: errorBody('error_resource_not_found', 'Resource does not exist'),
      };
    }
    if (entity.status !== 'incomplete') {
      return {
        status: 400,
        body: errorBody(
          'error_entity_status_not_incomplete',
          'Action requires an incomplete entity profile',
        ),
      };
    }
    entity.status = this.submitStatus;
    entity.submissions += 1;
    const answer: StandinAnswer = {
      status: 201,
      body: envelope(
        { entity: this.entityJson(entity).entity },
        'Onboarding completed successfully',
      ),
    };
    if (mode === 'made_then_500') {
      return { status: 500, body: errorBody('error_system_internal_error') };
    }
    if (mode === 'late') return { ...answer, delayMs: this.lateMs };
    return answer;
  }

  private getEntity(req: StandinRequest): StandinAnswer {
    const e = this.entities.get(req.path.split('/')[2]);
    return e
      ? {
          status: 200,
          body: envelope(this.entityJson(e), 'Entity retrieved successfully'),
        }
      : {
          status: 404,
          body: errorBody(
            'error_resource_not_found',
            'Resource does not exist',
          ),
        };
  }

  private patchEntity(req: StandinRequest): StandinAnswer {
    const e = this.entities.get(req.path.split('/')[2]);
    if (!e) {
      return {
        status: 404,
        body: errorBody('error_resource_not_found', 'Resource does not exist'),
      };
    }
    if (this.linkRefuse) return this.fail(this.linkRefuse);
    const meta = (req.body as { meta?: Record<string, unknown> } | null)?.meta;
    if (meta) Object.assign(e.meta, meta);
    return {
      status: 200,
      body: envelope(this.entityJson(e), 'Individual entity updated'),
    };
  }

  private startSession(req: StandinRequest): StandinAnswer {
    const mode = this.sessionMode;
    if (typeof mode === 'object') return this.fail(mode);
    if (mode === 'nothing_then_500') {
      return { status: 500, body: errorBody('error_system_internal_error') };
    }
    const b = (req.body ?? {}) as { entity_id?: string; redirect_url?: string };
    const id = ulid('01LIV');
    const session: HeldSession = {
      id,
      entityId: b.entity_id ?? null,
      redirectUrl: b.redirect_url ?? null,
      captureStatus: 'pending',
      verificationStatus: 'pending',
      initiatedAt: Date.now(),
      url: `https://verify.example.invalid/capture/${id}`,
    };
    this.sessions.set(id, session);
    const answer: StandinAnswer = {
      status: 201,
      body: envelope(
        { url: session.url, query_id: id },
        'Session created successfully',
      ),
    };
    return mode === 'late' ? { ...answer, delayMs: this.lateMs } : answer;
  }

  private getSession(req: StandinRequest): StandinAnswer {
    const s = this.sessions.get(req.path.split('/')[4]);
    if (!s) {
      return {
        status: 404,
        body: errorBody('error_resource_not_found', 'Resource does not exist'),
      };
    }
    return {
      status: 200,
      body: envelope(
        {
          capture_status: s.captureStatus,
          verification_status: s.verificationStatus,
          initiated_at: s.initiatedAt,
          capture_url: s.url,
        },
        'Session retrieved',
      ),
    };
  }
}

/** A ULID-shaped id with a readable prefix. */
export function ulid(prefix: string): string {
  return `${prefix}${randomUUID().replace(/-/g, '').toUpperCase()}`.slice(
    0,
    26,
  );
}
