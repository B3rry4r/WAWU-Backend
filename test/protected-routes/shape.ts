/**
 * Response-shape fingerprints for the protected route suite (MONEY-01).
 *
 * A fingerprint records the STRUCTURE of a JSON body, never its values:
 *
 *   "string" | "number" | "boolean" | "null" | "unknown"
 *   "string|null"                      a scalar seen both ways
 *   [Shape]                            a non-empty array; Shape is the merge of
 *                                      every element that was observed
 *   []                                 an array that was empty when recorded,
 *                                      so its element shape is not known
 *   { "key": Shape, "opt?": Shape }    an object; a key ending in "?" was
 *                                      absent from at least one observed
 *                                      sibling, so it may be missing
 *   { "$or": [Shape, Shape] }          two structurally different values seen
 *                                      in the same place
 *   { "$map": Shape }                  an object whose KEYS are data (a count
 *                                      per category, say); only the values'
 *                                      shape is pinned. Set by `mapPaths`.
 *
 * The comparison is deliberately strict about structure and lenient about
 * data:
 *
 *   - a key the lock knows that the response no longer carries FAILS (a rename
 *     or a removal);
 *   - a key the response carries that the lock does not know FAILS (a widened
 *     response: WORKFLOW.md section 9 sends that to the owner);
 *   - a value whose JSON type changed FAILS (string -> number, object -> array);
 *   - `null` where a typed value was recorded PASSES, and anything where only
 *     `null` was recorded PASSES. Nullability depends on the data a run
 *     happens to see, and a suite that flaps on it would be switched off.
 *   - an array recorded empty accepts any elements, and an empty array always
 *     matches a recorded element shape, for the same reason.
 */

export type Shape = string | Shape[] | { [key: string]: Shape };

const OR = '$or';
const MAP = '$map';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function scalarName(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  return 'unknown';
}

/** Splits `opt?` into its real name and whether it is optional. */
function splitKey(key: string): { name: string; optional: boolean } {
  return key.endsWith('?')
    ? { name: key.slice(0, -1), optional: true }
    : { name: key, optional: false };
}

function matchesPath(path: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => {
    // `*` stands for one key; everything else is literal.
    const escaped = p
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\\\*/g, '[^.[]+');
    return new RegExp(`^${escaped}$`).test(path);
  });
}

/**
 * The fingerprint of one value. `mapPaths` names objects whose keys are data;
 * paths are dotted from the response body, with `[]` for "every element"
 * (e.g. `data.byCategory`, `data[].counts`).
 */
export function fingerprint(
  value: unknown,
  mapPaths: readonly string[] = [],
  path = '',
): Shape {
  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    let merged: Shape | undefined;
    for (const el of value) {
      const s = fingerprint(el, mapPaths, `${path}[]`);
      merged = merged === undefined ? s : mergeShapes(merged, s);
    }
    return [merged as Shape];
  }
  if (isPlainObject(value)) {
    if (matchesPath(path, mapPaths)) {
      let merged: Shape | undefined;
      for (const [k, v] of Object.entries(value)) {
        const s = fingerprint(v, mapPaths, `${path}.${k}`);
        merged = merged === undefined ? s : mergeShapes(merged, s);
      }
      return { [MAP]: merged ?? 'unknown' };
    }
    const out: Record<string, Shape> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = fingerprint(
        value[key],
        mapPaths,
        path ? `${path}.${key}` : key,
      );
    }
    return out;
  }
  return scalarName(value);
}

function kindOf(s: Shape): 'scalar' | 'array' | 'object' | 'or' | 'map' {
  if (typeof s === 'string') return 'scalar';
  if (Array.isArray(s)) return 'array';
  if (OR in s) return 'or';
  if (MAP in s) return 'map';
  return 'object';
}

function scalarSet(s: string): Set<string> {
  return new Set(s.split('|'));
}

/** Union of two observed shapes (used for array elements and re-recording). */
export function mergeShapes(a: Shape, b: Shape): Shape {
  const ka = kindOf(a);
  const kb = kindOf(b);
  if (ka === 'scalar' && kb === 'scalar') {
    const set = new Set([...scalarSet(a as string), ...scalarSet(b as string)]);
    if (set.size > 1) set.delete('unknown');
    return [...set].sort().join('|');
  }
  // null merged with a structure: keep the structure, nullability is lenient.
  if (ka === 'scalar' && (a as string) === 'null') return b;
  if (kb === 'scalar' && (b as string) === 'null') return a;
  if (ka === 'array' && kb === 'array') {
    const aa = a as Shape[];
    const bb = b as Shape[];
    if (aa.length === 0) return bb;
    if (bb.length === 0) return aa;
    return [mergeShapes(aa[0], bb[0])];
  }
  if (ka === 'map' && kb === 'map') {
    return {
      [MAP]: mergeShapes(
        (a as Record<string, Shape>)[MAP],
        (b as Record<string, Shape>)[MAP],
      ),
    };
  }
  if (ka === 'object' && kb === 'object') {
    const ao = a as Record<string, Shape>;
    const bo = b as Record<string, Shape>;
    const names = new Map<
      string,
      { inA?: [string, Shape]; inB?: [string, Shape] }
    >();
    for (const [k, v] of Object.entries(ao))
      names.set(splitKey(k).name, {
        ...names.get(splitKey(k).name),
        inA: [k, v],
      });
    for (const [k, v] of Object.entries(bo))
      names.set(splitKey(k).name, {
        ...names.get(splitKey(k).name),
        inB: [k, v],
      });
    const out: Record<string, Shape> = {};
    for (const name of [...names.keys()].sort()) {
      const { inA, inB } = names.get(name)!;
      const optional =
        !inA || !inB || splitKey(inA[0]).optional || splitKey(inB[0]).optional;
      const merged =
        inA && inB ? mergeShapes(inA[1], inB[1]) : (inA ?? inB)![1];
      out[optional ? `${name}?` : name] = merged;
    }
    return out;
  }
  const alts = [
    ...(ka === 'or' ? (a as Record<string, Shape[]>)[OR] : [a]),
    ...(kb === 'or' ? (b as Record<string, Shape[]>)[OR] : [b]),
  ];
  const unique: Shape[] = [];
  for (const s of alts)
    if (!unique.some((u) => JSON.stringify(u) === JSON.stringify(s)))
      unique.push(s);
  return { [OR]: unique };
}

/**
 * Every way `actual` departs from the locked `expected` shape. An empty list
 * means the response still has the shape the web and the dashboard were
 * built against.
 */
export function compareShape(
  expected: Shape,
  actual: unknown,
  path = 'body',
): string[] {
  if (actual === null) return [];
  switch (kindOf(expected)) {
    case 'scalar': {
      const allowed = scalarSet(expected as string);
      if (allowed.has('unknown') || (allowed.size === 1 && allowed.has('null')))
        return [];
      const got = scalarName(actual);
      if (Array.isArray(actual))
        return [`${path}: locked as ${expected as string}, now an array`];
      if (isPlainObject(actual))
        return [`${path}: locked as ${expected as string}, now an object`];
      return allowed.has(got)
        ? []
        : [`${path}: locked as ${expected as string}, now ${got}`];
    }
    case 'array': {
      if (!Array.isArray(actual))
        return [
          `${path}: locked as an array, now ${isPlainObject(actual) ? 'an object' : scalarName(actual)}`,
        ];
      const el = (expected as Shape[])[0];
      if (el === undefined) return [];
      const problems: string[] = [];
      actual.forEach((item, i) =>
        problems.push(...compareShape(el, item, `${path}[${i}]`)),
      );
      return dedupe(problems);
    }
    case 'or': {
      const alts = (expected as Record<string, Shape[]>)[OR];
      const results = alts.map((s) => compareShape(s, actual, path));
      if (results.some((r) => r.length === 0)) return [];
      return [
        `${path}: matches none of the ${alts.length} locked alternatives (${results.map((r) => r[0]).join(' / ')})`,
      ];
    }
    case 'map': {
      if (!isPlainObject(actual))
        return [
          `${path}: locked as an object map, now ${Array.isArray(actual) ? 'an array' : scalarName(actual)}`,
        ];
      const vs = (expected as Record<string, Shape>)[MAP];
      const problems: string[] = [];
      for (const [k, v] of Object.entries(actual))
        problems.push(...compareShape(vs, v, `${path}.${k}`));
      return dedupe(problems);
    }
    case 'object': {
      if (!isPlainObject(actual))
        return [
          `${path}: locked as an object, now ${Array.isArray(actual) ? 'an array' : scalarName(actual)}`,
        ];
      const problems: string[] = [];
      const known = new Set<string>();
      for (const [key, s] of Object.entries(
        expected as Record<string, Shape>,
      )) {
        const { name, optional } = splitKey(key);
        known.add(name);
        if (!(name in actual)) {
          if (!optional)
            problems.push(
              `${path}.${name}: missing (locked key removed or renamed)`,
            );
          continue;
        }
        problems.push(...compareShape(s, actual[name], `${path}.${name}`));
      }
      for (const name of Object.keys(actual)) {
        if (!known.has(name))
          problems.push(`${path}.${name}: not in the lock (response widened)`);
      }
      return problems;
    }
  }
}

function dedupe(problems: string[]): string[] {
  // Array elements repeat the same finding once per element; report each
  // distinct finding once, with its first index.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of problems) {
    const key = p.replace(/\[\d+\]/g, '[]');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}
