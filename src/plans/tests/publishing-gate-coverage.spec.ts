import {
  INTERCEPTORS_METADATA,
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { RequestMethod } from '@nestjs/common';
import type { MetadataStorage } from 'class-transformer/types/MetadataStorage';
import { Type } from 'class-transformer';
import {
  IsNumber,
  IsString,
  ValidateNested,
  getMetadataStorage,
} from 'class-validator';
import { AppModule } from '../../app.module';
import { PublishingOffersInterceptor } from '../publishing-offers.interceptor';

/**
 * class-transformer keeps what `@Type(() => X)` says in a store it does not
 * export from its index, and the package has no typings for the file that
 * holds it: read it with its own type.
 */
const transformerTypes = jest.requireActual<{
  defaultMetadataStorage: MetadataStorage;
}>('class-transformer/cjs/storage').defaultMetadataStorage;

/**
 * EVERY ROUTE THAT PUBLISHES A PIECE OR TAKES A FILE FOR ONE ASKS THE GATE
 * (task TIER-02).
 *
 * "Every route that publishes content, a product or a service, or accepts a
 * file (the report lists each) answers 402 tier_required". This is that list,
 * held to the code over every controller AppModule mounts:
 *
 * - the routes that carry `@GatesPublishing()` are exactly GATED below, so a
 *   gated route cannot lose the offers and an ungated one cannot gain them
 *   without this list (and the report) changing;
 * - every mounted route whose request body can carry a product's file
 *   (`previewAsset`, `fullAsset`), a list of files under any common name
 *   (`images`, `files`, `media`, `attachments`, `documents`, `frames`), a file
 *   inside a nested class, or names an upload folder (`folder`) is in GATED,
 *   or is in NOT_GATED with the properties it has and the reason it is not a
 *   product. A route that gains a file property fails until the list says so.
 */

/** The routes the publishing gate stands in front of, and what each does. */
const GATED: Record<string, string> = {
  'POST content': 'publishes a piece (needs a tier and a free place)',
  'PATCH content/:id':
    'replaces the file of a piece waiting for review (needs a way to publish)',
  'POST content/:id/resubmit':
    'sends a turned-down piece again (takes a place)',
  'POST uploads/presign':
    'signs a file upload; content/preview and content/full are products, the other folders are not',
  'POST product-drafts/:id/publish':
    'publishes a draft with its two files (needs a tier and a free place)',
};

/**
 * Routes with a file-shaped body that are NOT a product's file, and why, with
 * the file-carrying properties each one has (TIER-02 round 3, T8: the list of
 * properties is held exactly, so a route that GAINS one, say `images` next to
 * `frames`, fails until someone says what it is). A new route needs a reason
 * of more than ten characters.
 */
const NOT_GATED: Record<string, { files: string[]; why: string }> = {
  // Profile content: "build a profile free" (R-43); a wallet must open
  // before a first purchase, so identity documents never wait for a tier.
  'PATCH users/me': {
    files: [
      'avatarUrl',
      'coverUrl',
      'facebookUrl',
      'linkedinUrl',
      'websiteUrl',
      'youtubeUrl',
    ],
    why: 'profile pictures and social links (avatar, cover, links)',
  },
  'POST users/me/featured-works': {
    files: ['link', 'media'],
    why: 'a showreel on the profile (photos and video up to 100 MB, and a link to the work), profile content and not a product; U2 asks the owner whether it needs a tier',
  },
  'PATCH users/me/featured-works/:id': {
    files: ['link', 'media'],
    why: 'a showreel on the profile (photos and video up to 100 MB, and a link to the work), profile content and not a product; U2 asks the owner whether it needs a tier',
  },
  'POST kyc': {
    files: ['idDocumentUrl'],
    why: 'an identity document, needed to open a wallet and buy a tier',
  },
  'POST money/identity/selfie': {
    files: ['image'],
    why: 'the selfie of the identity check that opens a wallet, before any tier can be bought',
  },
  // Links to files the person already uploaded through a presign that was asked: not a new file.
  'PUT content/:id/media': {
    files: ['frames'],
    why: "links to the person's own earlier content/ uploads (made through the gated presign) set as the frames of one of their own pieces that is not removed, whether it is waiting, live or turned down; creator accounts only, no tier asked (U3, PLANS.md section 6)",
  },
  // Applications and requests: the documents are links to files uploaded through
  // the identity and document folders of the presign, which no tier is asked for.
  'POST legal/requests': {
    files: ['documents'],
    why: 'documents for a legal desk request, uploaded through the document folders of the presign',
  },
  'PATCH legal/intake/:id/answers': {
    files: ['documents'],
    why: 'documents for a legal intake, uploaded through the document folders of the presign',
  },
  'POST services/cac/apply': {
    files: ['documents'],
    why: 'documents for a CAC registration application',
  },
  'POST services/nepc/apply': {
    files: ['documents'],
    why: 'documents for an NEPC application',
  },
  'POST services/partner/apply': {
    files: ['documents'],
    why: 'documents for a partner application',
  },
  'POST service-applications/partner/apply': {
    files: ['documents'],
    why: 'documents for a partner application',
  },
  'POST professionals/applications': {
    files: ['documents'],
    why: 'documents for a professional application, needed before any listing',
  },
  'POST verification/submissions': {
    files: ['documents'],
    why: "the verification tick's documents: any signed-in account may send them for staff to review (one pending at a time); the verification levels are not maker tiers, and nothing is published",
  },
  'POST verification/submissions/:id/resubmit': {
    files: ['documents'],
    why: "the verification tick's documents sent again after a turn-down, for staff to review; the verification levels are not maker tiers, and nothing is published",
  },
  // Not a person's own product.
  'POST communities/:id/messages': {
    files: ['imageUrl'],
    why: 'a picture in a community chat',
  },
  'POST communities': {
    files: ['imageUrl'],
    why: 'a community picture',
  },
  'PATCH communities/:id': {
    files: ['imageUrl'],
    why: 'a community picture',
  },
  'POST communities/rooms': {
    files: ['imageUrl'],
    why: 'a community room picture',
  },
  'POST chats/:chatId/messages': {
    files: ['attachment', 'attachment.key'],
    why: 'a picture, video or PDF in a private chat, uploaded through the chat attachment link',
  },
  'POST events': {
    files: ['bannerUrl', 'externalUrl', 'speakers.photoUrl'],
    why: 'an event banner, links and speaker pictures; hosting by tier is E21',
  },
  'PATCH events/:id': {
    files: ['bannerUrl', 'externalUrl', 'recapUrl', 'speakers.photoUrl'],
    why: 'an event banner, links and speaker pictures; hosting by tier is E21',
  },
  'POST payments/hosted-link': {
    files: ['redirectUrl'],
    why: 'the address a payment returns the person to',
  },
  // Staff and operations: not a creator publishing.
  'POST legal/ops/requests/:id/deliver': {
    files: ['deliverableUrl'],
    why: 'a legal desk hands a document to a client (a service delivery)',
  },
  'POST legal/ops/requests/:id/deliverables': {
    files: ['files', 'files.url'],
    why: 'staff attach files to a legal request they are working on',
  },
  'POST services/ops/applications/:id/approve': {
    files: ['certificateUrl'],
    why: 'staff approve a service application with a certificate link',
  },
  'POST admin/schools': {
    files: ['applyUrl', 'logo'],
    why: 'an admin writes a school logo and a link to its application page',
  },
  'PATCH admin/schools/:id': {
    files: ['applyUrl', 'logo'],
    why: 'an admin writes a school logo and a link to its application page',
  },
  'POST admin/shop/products': {
    files: ['images'],
    why: 'an admin writes a shop product with its pictures (the shop has no creator route, R-2)',
  },
  'PUT admin/shop/products/:id': {
    files: ['images'],
    why: 'an admin writes a shop product with its pictures (the shop has no creator route, R-2)',
  },
  'POST admin/ads': {
    files: ['creative.artworkUrl'],
    why: 'an admin writes an ad with its artwork',
  },
  'PATCH admin/ads/:id': {
    files: ['creative.artworkUrl'],
    why: 'an admin writes an ad with its artwork',
  },
  'PATCH learn/playbook': {
    files: ['fileUrl'],
    why: 'an admin writes the learn playbook',
  },
  'POST learn/guides': {
    files: ['fileUrl'],
    why: 'an admin writes a learn guide',
  },
  'PATCH learn/guides/:id': {
    files: ['fileUrl'],
    why: 'an admin writes a learn guide',
  },
  'POST admin/notifications/campaigns': {
    files: ['imageUrl'],
    why: 'an admin campaign picture',
  },
  'PATCH admin/notifications/campaigns/:id': {
    files: ['imageUrl'],
    why: 'an admin campaign picture',
  },
  'POST admin/professionals/:id/document-url': {
    files: ['documentUrl'],
    why: 'an admin asks for a signed link to read a professional document',
  },
  // Not a file at all: a link or a key that only has a file-like name.
  'PUT money/device': {
    files: ['publicKey'],
    why: 'a device public key, not a file',
  },
  'POST money/identity/liveness': {
    files: ['redirectUrl'],
    why: 'the address the identity check returns the person to',
  },
};

/**
 * Routes that take a file as a multipart upload. Such a route has no body
 * property to list (round 4, T11), so the walk reads the handler: an
 * `@UploadedFile(s)` parameter, or `multipart/form-data` documented on it.
 * Each is gated or says here why it is not a product's file.
 */
const MULTIPART_NOT_GATED: Record<string, string> = {
  'POST money/identity/documents':
    'an identity document or proof of address (PDF, JPG or PNG, up to 10 MB) forwarded to the wallet provider for the wallet opening; WAWU keeps no copy, and signed-in accounts only, no tier',
};

/**
 * Whether a property of a request body carries a file, or names where one
 * goes. Three ways, so a body that gains a file under a NEW name or shape is
 * seen (round 2, T5: `assetUrl`; round 3, T8: `images`, and a file inside a
 * nested class):
 *
 * - by name: `folder`, a name ending `asset`, `url`, `uri`, `key`, `src` or
 *   `link` in either case (so the bare `url`, `key` and `src` count, and so
 *   do `mediaUri` and `imageUrls`; singular or plural), or a name that is, or
 *   ends in, one of the words in FILE_WORDS (`images`, `coverImage`,
 *   `attachments`, `documents`, `frames`, `thumb`, `data`) (round 4, T11);
 * - by type: a property whose type is a class that names an upload or an
 *   asset reference (`PresignUploadDto`, `ChatAttachmentDto`, anything with
 *   Presign, Upload, Asset or Attachment in its name), also as the item type
 *   of an array;
 * - by what is inside: a nested class, also as the item type of an array, is
 *   read the same way, its properties reported with their path
 *   (`attachment.key`, `sections.thumb`).
 *
 * A file sent as a multipart upload has no body property at all: those routes
 * are found from the handler (`@UploadedFile(s)`, `multipart/form-data`) and
 * listed in MULTIPART_NOT_GATED.
 */
const FILE_WORDS = [
  'image',
  'images',
  'file',
  'files',
  'media',
  'attachment',
  'attachments',
  'document',
  'documents',
  'frame',
  'frames',
  'photo',
  'photos',
  'picture',
  'pictures',
  'video',
  'videos',
  'audio',
  'gallery',
  'thumbnail',
  'thumbnails',
  'logo',
  'upload',
  'uploads',
  'thumb',
  'thumbs',
  'cover',
  'poster',
  'banner',
  'avatar',
  'icon',
  'blob',
  'data',
];
const isFileName = (name: string): boolean =>
  name === 'folder' ||
  /(asset|url|uri|key|src|link)s?$/i.test(name) ||
  FILE_WORDS.some(
    (w) =>
      name.toLowerCase() === w ||
      name.endsWith(w.charAt(0).toUpperCase() + w.slice(1)),
  );
const isFileType = (cls: unknown): boolean =>
  typeof cls === 'function' &&
  /(Presign|Upload|Asset|Attachment)/i.test(cls.name);
const PLAIN = new Set<unknown>([String, Number, Boolean, Array, Object, Date]);

type Route = {
  key: string;
  controller: string;
  handler: string;
  gated: boolean;
  fileProperties: string[];
  /** The handler takes `@UploadedFile(s)` or documents `multipart/form-data`: a file with no body property. */
  multipart: boolean;
};

/** Where @nestjs/swagger's `@ApiConsumes` keeps its list (the package does not export the constant). */
const API_CONSUMES_METADATA = 'swagger/apiConsumes';

/** Every module reachable from `root` through `imports`, dynamic and forwardRef ones included. */
function reachable(root: unknown): Set<unknown> {
  const seen = new Set<unknown>();
  const stack: unknown[] = [root];
  while (stack.length) {
    let mod = stack.pop();
    if (mod && typeof mod === 'object' && 'forwardRef' in mod) {
      mod = (mod as { forwardRef: () => unknown }).forwardRef();
    }
    if (mod && typeof mod === 'object' && 'module' in mod) {
      stack.push(...((mod as { imports?: unknown[] }).imports ?? []));
      mod = mod.module;
    }
    if (!mod || seen.has(mod)) continue;
    seen.add(mod);
    stack.push(
      ...((Reflect.getMetadata(MODULE_METADATA.IMPORTS, mod) ??
        []) as unknown[]),
    );
  }
  return seen;
}

function join(...parts: string[]): string {
  return parts
    .flatMap((p) => p.split('/'))
    .filter((p) => p !== '')
    .join('/');
}

/** The file-carrying properties of a body class, nested classes included (path `a.b`). */
function fileProperties(
  cls: unknown,
  prefix = '',
  seen: ReadonlySet<unknown> = new Set(),
): string[] {
  if (typeof cls !== 'function' || seen.has(cls)) return [];
  const inside = new Set(seen).add(cls);
  const names = new Set(
    getMetadataStorage()
      .getTargetValidationMetadatas(cls, '', false, false)
      .map((m) => m.propertyName),
  );
  const found: string[] = [];
  for (const name of names) {
    const path = `${prefix}${name}`;
    const declared = Reflect.getMetadata(
      'design:type',
      cls.prototype as object,
      name,
    ) as unknown;
    const item = (
      transformerTypes.findTypeMetadata(cls, name) as
        { typeFunction?: () => unknown } | undefined
    )?.typeFunction?.();
    const nested = [item, declared].find(
      (t) => typeof t === 'function' && !PLAIN.has(t),
    );
    if (isFileName(name) || isFileType(nested)) found.push(path);
    if (nested) found.push(...fileProperties(nested, `${path}.`, inside));
  }
  return found;
}

function routesOf(
  controllers: Array<{ name: string; prototype: object }>,
): Route[] {
  const routes: Route[] = [];
  for (const controller of controllers) {
    const base = (Reflect.getMetadata(PATH_METADATA, controller) ?? '') as
      string | string[];
    const proto = controller.prototype as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(proto)) {
      const handler = proto[name];
      if (name === 'constructor' || typeof handler !== 'function') continue;
      const path = Reflect.getMetadata(PATH_METADATA, handler) as
        string | string[] | undefined;
      if (path === undefined) continue;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as number;
      const interceptors = [
        ...((Reflect.getMetadata(INTERCEPTORS_METADATA, controller) ??
          []) as unknown[]),
        ...((Reflect.getMetadata(INTERCEPTORS_METADATA, handler) ??
          []) as unknown[]),
      ];
      const paramTypes = (Reflect.getMetadata(
        'design:paramtypes',
        proto,
        name,
      ) ?? []) as unknown[];
      const props = paramTypes.flatMap((t) => fileProperties(t));
      const args = Object.keys(
        (Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, name) ??
          {}) as object,
      );
      const consumes = (Reflect.getMetadata(API_CONSUMES_METADATA, handler) ??
        []) as string[];
      routes.push({
        key: `${RequestMethod[method]} ${join(String(base), String(path))}`,
        controller: controller.name,
        handler: name,
        gated: interceptors.includes(PublishingOffersInterceptor),
        fileProperties: [...new Set(props)].sort(),
        multipart:
          args.some((a) =>
            [RouteParamtypes.FILE, RouteParamtypes.FILES].includes(
              Number(a.split(':')[0]),
            ),
          ) || consumes.includes('multipart/form-data'),
      });
    }
  }
  return routes;
}

describe('the publishing gate covers every route that publishes or takes a file (TIER-02)', () => {
  const mounted = routesOf(
    [...reachable(AppModule)].flatMap(
      (mod) =>
        (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, mod as object) ??
          []) as Array<{ name: string; prototype: object }>,
    ),
  );

  it('finds the routes it checks (the walk itself works)', () => {
    const keys = mounted.map((r) => r.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        'POST content',
        'POST uploads/presign',
        'GET me/tier',
        'POST product-drafts',
      ]),
    );
  });

  it('the routes that carry the gate are exactly the listed ones', () => {
    const gated = mounted
      .filter((r) => r.gated)
      .map((r) => r.key)
      .sort();
    expect(gated).toEqual(Object.keys(GATED).sort());
  });

  it('every listed route is mounted', () => {
    const keys = new Set(mounted.map((r) => r.key));
    expect(Object.keys(GATED).filter((k) => !keys.has(k))).toEqual([]);
  });

  it('every route that says why it is not gated is mounted and carries exactly the file properties it lists', () => {
    const byKey = new Map(mounted.map((r) => [r.key, r]));
    const wrong = Object.entries(NOT_GATED)
      .filter(
        ([k, entry]) =>
          JSON.stringify(byKey.get(k)?.fileProperties ?? null) !==
          JSON.stringify([...entry.files].sort()),
      )
      .map(([k, entry]) => ({
        route: k,
        listed: entry.files,
        found: byKey.get(k)?.fileProperties ?? 'not mounted',
      }));
    expect(wrong).toEqual([]);
  });

  it('a mounted route whose body can carry a product file is gated, or says why it is not', () => {
    const ungated = mounted
      .filter((r) => r.fileProperties.length > 0 && !r.gated)
      .map((r) => r.key)
      .filter((k) => !(k in NOT_GATED));
    expect(ungated).toEqual([]);
    for (const { why } of Object.values(NOT_GATED))
      expect(why.length).toBeGreaterThan(10);
  });

  it('a route that takes a multipart upload is gated, or says why it is not (round 4, T11)', () => {
    const multipart = mounted.filter((r) => r.multipart).map((r) => r.key);
    expect(multipart.length).toBeGreaterThan(0);
    const unlisted = multipart.filter(
      (k) => !(k in MULTIPART_NOT_GATED) && !(k in GATED),
    );
    expect(unlisted).toEqual([]);
    // And the list holds only routes that still take one.
    expect(
      Object.keys(MULTIPART_NOT_GATED).filter((k) => !multipart.includes(k)),
    ).toEqual([]);
    for (const why of Object.values(MULTIPART_NOT_GATED))
      expect(why.length).toBeGreaterThan(10);
  });

  it('a gated route is never also listed as not gated', () => {
    expect(Object.keys(NOT_GATED).filter((k) => k in GATED)).toEqual([]);
  });
});

/**
 * The walk's own rules (TIER-02 round 4, T11). The checks above hold real
 * routes to real lists; these hold the rules that FIND a file property, with
 * made-up bodies, so a rule weakened (a suffix test that is case-sensitive
 * again, a name dropped from the list, a nested array no longer read) fails
 * here and not only when a real route happens to need it.
 */
describe('how the walk finds a file property in a request body', () => {
  class Item {
    @IsString() thumb!: string;
    @IsString() caption!: string;
  }
  class Inner {
    @IsString() photo!: string;
  }
  class Outer {
    @ValidateNested() @Type(() => Inner) inner!: Inner;
  }
  class Plain {
    @IsString() title!: string;
    @IsString() description!: string;
    @IsNumber() price!: number;
    @IsString() category!: string;
    @IsString() handle!: string;
  }
  const one = (name: string): string[] => {
    class Body {}
    IsString()(Body.prototype, name);
    return fileProperties(Body);
  };

  it('sees a bare lower-case name for a link or a key (url, key, src, uri, link, data)', () => {
    for (const name of ['url', 'key', 'src', 'uri', 'link', 'data'])
      expect([name, one(name)]).toEqual([name, [name]]);
  });

  it('sees a name that ends in one, in either case (mediaUri, coverSrc, imageUrls, assetKey, pdfLink)', () => {
    for (const name of [
      'mediaUri',
      'coverSrc',
      'imageUrls',
      'assetKey',
      'pdfLink',
      'previewAsset',
    ])
      expect([name, one(name)]).toEqual([name, [name]]);
  });

  it('sees the file words, bare or at the end of a name (thumb, coverImage, frames, video)', () => {
    for (const name of ['thumb', 'coverImage', 'frames', 'video', 'folder'])
      expect([name, one(name)]).toEqual([name, [name]]);
  });

  it('sees a file in a class nested in an array, and two classes down', () => {
    class Body {
      @ValidateNested({ each: true }) @Type(() => Item) sections!: Item[];
    }
    class Deep {
      @ValidateNested() @Type(() => Outer) outer!: Outer;
    }
    expect(fileProperties(Body)).toEqual(['sections.thumb']);
    expect(fileProperties(Deep)).toEqual(['outer.inner.photo']);
  });

  it('leaves the plain fields of a product alone', () => {
    expect(fileProperties(Plain)).toEqual([]);
  });
});
