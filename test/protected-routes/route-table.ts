import { INestApplication, RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import { ADMIN_ROLES_KEY } from '../../src/admin/auth/decorators/admin-roles.decorator';

/**
 * Every route the composed application actually mounts, with the guards and
 * admin roles Nest will enforce on it, read from the same decorator metadata
 * the router uses. Paths are written without the global `/api/hub` prefix,
 * the convention `.pipeline/protected-registry.json` has always used.
 */
export interface LiveRoute {
  method: string;
  path: string;
  controller: string;
  handler: string;
  guards: string[];
  adminRoles: string[] | null;
}

const METHOD_NAMES: Record<number, string> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.DELETE]: 'DELETE',
  [RequestMethod.PATCH]: 'PATCH',
  [RequestMethod.ALL]: 'ALL',
  [RequestMethod.OPTIONS]: 'OPTIONS',
  [RequestMethod.HEAD]: 'HEAD',
};

type Ctor = { name: string; prototype: Record<string, unknown> };

function guardNames(target: object): string[] {
  const guards =
    (Reflect.getMetadata(GUARDS_METADATA, target) as unknown[] | undefined) ??
    [];
  return guards.map((g) =>
    typeof g === 'function' ? g.name : (g as object).constructor.name,
  );
}

function joinPath(base: string, sub: string): string {
  const joined =
    `/${[base, sub].filter((p) => p && p !== '/').join('/')}`.replace(
      /\/+/g,
      '/',
    );
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined;
}

export function liveRoutes(app: INestApplication): LiveRoute[] {
  const modules = app.get(ModulesContainer);
  const out: LiveRoute[] = [];
  const seen = new Set<unknown>();
  for (const mod of modules.values()) {
    for (const wrapper of mod.controllers.values()) {
      const cls = wrapper.metatype as unknown as Ctor | null;
      if (!cls || seen.has(cls)) continue;
      seen.add(cls);
      const basePaths = [
        Reflect.getMetadata(PATH_METADATA, cls) as string | string[],
      ].flat();
      const classGuards = guardNames(cls);
      const classRoles =
        (Reflect.getMetadata(ADMIN_ROLES_KEY, cls) as string[] | undefined) ??
        null;
      for (const name of Object.getOwnPropertyNames(cls.prototype)) {
        if (name === 'constructor') continue;
        const fn = cls.prototype[name];
        if (typeof fn !== 'function') continue;
        const sub = Reflect.getMetadata(PATH_METADATA, fn) as
          string | string[] | undefined;
        if (sub === undefined) continue;
        const method =
          METHOD_NAMES[Reflect.getMetadata(METHOD_METADATA, fn) as number];
        const roles =
          (Reflect.getMetadata(ADMIN_ROLES_KEY, fn) as string[] | undefined) ??
          classRoles;
        for (const base of basePaths) {
          for (const s of [sub].flat()) {
            out.push({
              method,
              path: joinPath(base, s),
              controller: cls.name,
              handler: name,
              guards: [...classGuards, ...guardNames(fn)],
              adminRoles: roles ? [...roles] : null,
            });
          }
        }
      }
    }
  }
  return out;
}
