import {
  INTERCEPTORS_METADATA,
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { getMetadataStorage } from 'class-validator';
import { AppModule } from '../../app.module';
import { PublishingOffersInterceptor } from '../publishing-offers.interceptor';

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
 *   (`previewAsset`, `fullAsset`) or names an upload folder (`folder`) is in
 *   GATED, or is in NOT_GATED with the reason it is not a product.
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
 * Routes with a file-shaped body that are NOT a product's file, and why.
 * A new entry needs that reason. The names are read by pattern (below), so a
 * route lands here whenever a body gains a property ending `Asset`, `Url` or
 * `Key`, and someone has to say what it is.
 */
const NOT_GATED: Record<string, string> = {
  // Profile content: "build a profile free" (R-43); a wallet must open
  // before a first purchase, so identity documents never wait for a tier.
  'PATCH users/me': 'profile pictures and social links (avatar, cover, links)',
  'POST kyc': 'an identity document, needed to open a wallet and buy a tier',
  // Not a person's own product.
  'POST communities/:id/messages': 'a picture in a community chat',
  'POST communities': 'a community picture',
  'PATCH communities/:id': 'a community picture',
  'POST communities/rooms': 'a community room picture',
  'POST events': 'an event banner and links; hosting by tier is E21',
  'PATCH events/:id': 'an event banner and links; hosting by tier is E21',
  // Staff and operations: not a creator publishing.
  'POST legal/ops/requests/:id/deliver':
    'a legal desk hands a document to a client (a service delivery)',
  'POST services/ops/applications/:id/approve':
    'staff approve a service application with a certificate link',
  'POST admin/schools': 'an admin writes a link to a school application page',
  'PATCH admin/schools/:id':
    'an admin writes a link to a school application page',
  'PATCH learn/playbook': 'an admin writes the learn playbook',
  'POST learn/guides': 'an admin writes a learn guide',
  'PATCH learn/guides/:id': 'an admin writes a learn guide',
  'POST admin/notifications/campaigns': 'an admin campaign picture',
  'PATCH admin/notifications/campaigns/:id': 'an admin campaign picture',
  'POST admin/professionals/:id/document-url':
    'an admin asks for a signed link to read a professional document',
  // Not a file at all: a link or a key that only has a file-like name.
  'PUT money/device': 'a device public key, not a file',
  'POST money/identity/liveness':
    'the address the identity check returns the person to',
  'POST payments/hosted-link': 'the address a payment returns the person to',
};

/**
 * Properties of a request body that carry a file, or name where one goes:
 * `folder` (an upload folder) and any property whose name ends `Asset`, `Url`
 * or `Key` (`previewAsset`, `fullAsset`, `assetUrl`, `fileKey`). A pattern and
 * not a list of names, so a body that gains a file under a NEW name is seen
 * (round 2, T5: a property called `assetUrl` was not).
 */
const isFileProperty = (name: string): boolean =>
  name === 'folder' || /(Asset|Url|Key)$/.test(name);

type Route = {
  key: string;
  controller: string;
  handler: string;
  gated: boolean;
  fileProperties: string[];
};

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

function propertiesOf(cls: unknown): string[] {
  if (typeof cls !== 'function') return [];
  return getMetadataStorage()
    .getTargetValidationMetadatas(cls, '', false, false)
    .map((m) => m.propertyName);
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
      const props = paramTypes.flatMap(propertiesOf);
      routes.push({
        key: `${RequestMethod[method]} ${join(String(base), String(path))}`,
        controller: controller.name,
        handler: name,
        gated: interceptors.includes(PublishingOffersInterceptor),
        fileProperties: [...new Set(props.filter(isFileProperty))],
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

  it('every route that says why it is not gated is mounted and does take a file-shaped body', () => {
    const byKey = new Map(mounted.map((r) => [r.key, r]));
    const stale = Object.keys(NOT_GATED).filter(
      (k) => (byKey.get(k)?.fileProperties.length ?? 0) === 0,
    );
    expect(stale).toEqual([]);
  });

  it('a mounted route whose body can carry a product file is gated, or says why it is not', () => {
    const ungated = mounted
      .filter((r) => r.fileProperties.length > 0 && !r.gated)
      .map((r) => r.key)
      .filter((k) => !(k in NOT_GATED));
    expect(ungated).toEqual([]);
    for (const why of Object.values(NOT_GATED))
      expect(why.length).toBeGreaterThan(10);
  });
});
