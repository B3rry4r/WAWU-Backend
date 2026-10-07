/**
 * Fills in the response half of contract/openapi.json.
 *
 * @nestjs/swagger reads request bodies and params off the DTO classes and gets
 * them right, but it cannot describe a response: these controllers declare no
 * return type (`return this.service.list(...)`), and an inferred type has no
 * runtime metadata for the plugin to read. Emitting the spec alone leaves 264
 * operations whose response schema is a bare {"type":"object"} — true, useless,
 * and impossible to generate a client type from.
 *
 * The shapes are not missing though, only invisible: the TypeScript checker
 * resolves each handler to a real named type (ContentPieceResponse,
 * Paginated<ContentPieceResponse>, ...). So this walks the controllers with the
 * compiler API, asks the checker what each handler actually returns, converts
 * that type to JSON Schema, and writes it into the spec the emitter produced.
 *
 * Authoring response DTO classes by hand instead would mean ~264 more
 * declarations restating what the services already return, and two truths to
 * keep in step. Reading the one that exists is cheaper and cannot drift.
 *
 * Run via `npm run contract:build` (emit, then enrich). Never edit
 * contract/openapi.json by hand.
 */
const ts = require('typescript');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SPEC = path.join(ROOT, 'contract', 'openapi.json');
const GLOBAL_PREFIX = '/api/hub';
const MAX_DEPTH = 12;

const HTTP_DECORATORS = new Map([
  ['Get', 'get'],
  ['Post', 'post'],
  ['Put', 'put'],
  ['Patch', 'patch'],
  ['Delete', 'delete'],
]);

/** components.schemas, filled as named types are encountered. */
const schemas = {};
/** Guards against a type alias that refers to itself (Comment.replies). */
const inProgress = new Set();

function decoratorsOf(node) {
  return ts.canHaveDecorators?.(node) ? (ts.getDecorators(node) ?? []) : [];
}

/** `@Get('mine')` -> {name:'Get', arg:'mine'}; `@Get()` -> {name:'Get', arg:''}. */
function readDecorator(dec) {
  const expr = dec.expression;
  if (!ts.isCallExpression(expr)) {
    return ts.isIdentifier(expr) ? { name: expr.text, arg: '' } : null;
  }
  if (!ts.isIdentifier(expr.expression)) return null;
  const first = expr.arguments[0];
  const arg =
    first && ts.isStringLiteralLike(first) ? first.text : '';
  return { name: expr.expression.text, arg };
}

/** Nest ':id' -> OpenAPI '{id}'. */
function toOpenApiPath(segments) {
  const joined = segments
    .filter(Boolean)
    .join('/')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
  const withBraces = joined.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
  return withBraces.startsWith('/') ? withBraces : `/${withBraces}`;
}

function isDateType(type) {
  return type.getSymbol()?.getName() === 'Date';
}

function typeArgsOf(checker, type) {
  return checker.getTypeArguments?.(type) ?? [];
}

/**
 * A named, reusable shape gets a components.schemas entry so the generated
 * client has one `ContentPieceResponse` rather than the same object literal
 * inlined at thirty call sites. Anonymous object literals stay inline.
 */
function namedSchemaKey(type) {
  const symbol = type.aliasSymbol ?? type.getSymbol();
  if (!symbol) return null;
  const name = symbol.getName();
  if (!name || name === '__type' || name === '__object') return null;
  if (['Array', 'Promise', 'Date', 'Object'].includes(name)) return null;
  const args = type.aliasTypeArguments ?? typeArgsOf(checker, type);
  if (args.length) return null; // generic instantiation: inline it
  return name;
}

let checker;

function toSchema(type, depth = 0) {
  if (depth > MAX_DEPTH) return {};

  const flags = type.flags;
  if (flags & ts.TypeFlags.Any || flags & ts.TypeFlags.Unknown) return {};
  if (flags & ts.TypeFlags.Never) return {};
  if (flags & ts.TypeFlags.StringLike && type.isStringLiteral()) {
    return { type: 'string', enum: [type.value] };
  }
  if (flags & ts.TypeFlags.NumberLike && type.isNumberLiteral()) {
    return { type: 'number', enum: [type.value] };
  }
  if (flags & ts.TypeFlags.String) return { type: 'string' };
  if (flags & ts.TypeFlags.Number) return { type: 'number' };
  if (flags & ts.TypeFlags.Boolean || flags & ts.TypeFlags.BooleanLiteral) {
    return { type: 'boolean' };
  }
  if (flags & ts.TypeFlags.BigInt) return { type: 'string', format: 'int64' };
  // OpenAPI 3.0 (what DocumentBuilder emits) has no `type: "null"` — that is a
  // 3.1 construct, and emitting it makes the redocly parser every generator
  // wraps throw before it produces a line. Nullability is `nullable: true`.
  if (flags & ts.TypeFlags.Null) return { nullable: true };
  if (flags & ts.TypeFlags.Undefined || flags & ts.TypeFlags.Void) return null;
  if (flags & ts.TypeFlags.EnumLike) {
    const values = (type.types ?? [type])
      .map((t) => (t.isStringLiteral() || t.isNumberLiteral() ? t.value : null))
      .filter((v) => v !== null);
    return values.length ? { type: 'string', enum: values } : { type: 'string' };
  }

  // Date serializes as an ISO string over the wire, never as an object.
  if (isDateType(type)) return { type: 'string', format: 'date-time' };

  if (type.isUnion()) return unionToSchema(type, depth);

  // `Omit<ContentPiece, 'fullAssetUrl'> & { ... }` is how most response types
  // here are built, and an intersection does NOT carry TypeFlags.Object — so
  // without this it fell through to `{}` and every content array came out as
  // `items: {}`. getPropertiesOfType already merges the members for us.
  if (type.isIntersection()) return objectToSchema(type, depth);

  if (checker.isArrayType?.(type)) {
    const [item] = typeArgsOf(checker, type);
    return { type: 'array', items: item ? (toSchema(item, depth + 1) ?? {}) : {} };
  }

  // A tuple (`['a','b'] as const`) is NOT an array type to the checker, so
  // without this it fell through to the object branch and got enumerated as
  // one: properties "0".."13", "length", and every Array.prototype method.
  // That is where the `toString` / `toLocaleString` schema properties came
  // from, and they crash any OpenAPI parser that looks a property name up on
  // its own type table (redocly finds Object.prototype.toString and calls it).
  if (checker.isTupleType?.(type)) {
    const elements = typeArgsOf(checker, type)
      .map((t) => toSchema(t, depth + 1))
      .filter(Boolean);
    return { type: 'array', items: mergeItemSchemas(elements) };
  }

  // Array-LIKE but not an array type: Prisma's `JsonArray extends Array<...>`,
  // and ReadonlyArray. Both carry a numeric index signature and `length`, and
  // both would otherwise be enumerated as objects full of Array.prototype.
  const numericIndex = checker.getIndexInfoOfType?.(type, ts.IndexKind.Number);
  if (numericIndex && type.getProperty?.('length')) {
    return { type: 'array', items: toSchema(numericIndex.type, depth + 1) ?? {} };
  }

  if (flags & ts.TypeFlags.Object) return objectToSchema(type, depth);

  return {};
}

/**
 * `T | null` is the shape this codebase actually uses; OpenAPI 3.0 has no
 * union type, so a nullable single type collapses to `nullable: true` rather
 * than a two-branch oneOf that generators render as `unknown`.
 */
function unionToSchema(type, depth) {
  const parts = type.types;
  const nullable = parts.some(
    (t) => t.flags & ts.TypeFlags.Null || t.flags & ts.TypeFlags.Undefined,
  );
  const real = parts.filter(
    (t) => !(t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)),
  );

  if (real.length === 0) return { nullable: true };

  // A union of string literals is an enum, not a oneOf.
  if (real.every((t) => t.isStringLiteral())) {
    const schema = { type: 'string', enum: real.map((t) => t.value) };
    if (nullable) schema.nullable = true;
    return schema;
  }

  // `boolean` is internally `true | false`; don't emit it as an enum.
  if (real.length === 2 && real.every((t) => t.flags & ts.TypeFlags.BooleanLiteral)) {
    return nullable ? { type: 'boolean', nullable: true } : { type: 'boolean' };
  }

  if (real.length === 1) {
    const schema = toSchema(real[0], depth + 1) ?? {};
    if (nullable) schema.nullable = true;
    return schema;
  }

  const schema = { oneOf: real.map((t) => toSchema(t, depth + 1) ?? {}) };
  if (nullable) schema.nullable = true;
  return schema;
}

function objectToSchema(type, depth) {
  const key = namedSchemaKey(type);
  if (key) {
    if (inProgress.has(key)) return { $ref: `#/components/schemas/${key}` };
    if (schemas[key]) return { $ref: `#/components/schemas/${key}` };
    inProgress.add(key);
    const built = buildObject(type, depth);
    inProgress.delete(key);
    schemas[key] = built;
    return { $ref: `#/components/schemas/${key}` };
  }
  return buildObject(type, depth);
}

/** Tuple elements collapse to one `items` schema: identical ones dedupe, mixed ones oneOf. */
function mergeItemSchemas(list) {
  if (list.length === 0) return {};
  const seen = new Map();
  for (const s of list) seen.set(JSON.stringify(s), s);
  const unique = [...seen.values()];
  if (unique.length === 1) return unique[0];
  // All string enums: one enum rather than a oneOf of single-value enums.
  if (unique.every((s) => s.type === 'string' && Array.isArray(s.enum))) {
    return { type: 'string', enum: [...new Set(unique.flatMap((s) => s.enum))] };
  }
  return { oneOf: unique };
}

/**
 * Names that can never be real payload fields here: anything inherited from
 * Object/Array.prototype, and TypeScript's symbol-keyed members
 * (`__@unscopables@184`). A schema property called `toString` makes redocly
 * look the name up on its own type table, find Object.prototype.toString, and
 * invoke it as a type function — so this is a correctness guard, not tidiness.
 */
const PROTOTYPE_NAMES = new Set([
  ...Object.getOwnPropertyNames(Object.prototype),
  ...Object.getOwnPropertyNames(Array.prototype),
]);

function isUnserializableName(name) {
  return PROTOTYPE_NAMES.has(name) || name.startsWith('__@');
}

/** A method is not part of a JSON body. Belt-and-braces against prototype leakage. */
function isMethodSymbol(prop, type) {
  const decl = prop.valueDeclaration ?? prop.declarations?.[0];
  if (decl && (ts.isMethodDeclaration(decl) || ts.isMethodSignature(decl))) return true;
  if (!decl) return false;
  const t = checker.getTypeOfSymbolAtLocation(prop, decl);
  return t.getCallSignatures().length > 0;
}

function buildObject(type, depth) {
  // Record<string, unknown> and friends: an index signature, no named props.
  const stringIndex = checker.getIndexInfoOfType?.(type, ts.IndexKind.String);
  const props = checker.getPropertiesOfType(type);
  if (stringIndex && props.length === 0) {
    return {
      type: 'object',
      additionalProperties: toSchema(stringIndex.type, depth + 1) ?? {},
    };
  }

  const properties = {};
  const required = [];
  for (const prop of props) {
    if (isUnserializableName(prop.getName())) continue;
    if (isMethodSymbol(prop, type)) continue;
    const decl = prop.valueDeclaration ?? prop.declarations?.[0];
    const propType = decl
      ? checker.getTypeOfSymbolAtLocation(prop, decl)
      : checker.getDeclaredTypeOfSymbol(prop);
    let schema = toSchema(propType, depth + 1);
    if (schema === null) continue; // pure undefined/void property
    if (declaredIn(type, NULLABLE_REF_AS_ALLOF_DIRS)) schema = nullableRefAsAllOf(schema);
    schema = koboAsInteger(prop.getName(), schema);
    properties[prop.getName()] = schema;
    const optional = prop.flags & ts.SymbolFlags.Optional;
    if (!optional) required.push(prop.getName());
  }

  const out = { type: 'object', properties };
  if (required.length) out.required = required;
  return out;
}

/**
 * `{ $ref, nullable: true }` is how unionToSchema writes `Named | null`, and
 * OpenAPI 3.0 ignores every sibling of a $ref: generators (openapi-typescript
 * included) read it as plain `Named`, so a field that can be null is typed
 * as never null. `{ allOf: [{ $ref }], nullable: true }` is the 3.0 form that
 * keeps the null.
 *
 * Only for types declared under these folders (task MONEY-04's wallet
 * contract, task INBOX-06's chat, task INBOX-07's inbox and task LEGAL-01's legal chat), so no schema a served route already publishes changes shape in
 * the contract. The eleven served fields still written the old way are listed
 * in docs/contract/WALLET.md, section 5.
 */
const NULLABLE_REF_AS_ALLOF_DIRS = [
  path.join(ROOT, 'src', 'money') + path.sep,
  // Free chat (task INBOX-06): new routes, so nothing published changes.
  path.join(ROOT, 'src', 'chat') + path.sep,
  // The legal chat before payment (task LEGAL-01): new routes, so nothing
  // published changes. The older legal-intake types stay as they are.
  path.join(ROOT, 'src', 'legal-intake', 'assistant') + path.sep,
  // The inbox (task INBOX-07): new routes, so nothing published changes.
  path.join(ROOT, 'src', 'inbox') + path.sep,
  // The caller's own lists (task ME-10): new routes, so nothing published changes.
  path.join(ROOT, 'src', 'me') + path.sep,
];

function declaredIn(type, dirs) {
  const symbol = type.aliasSymbol ?? type.getSymbol();
  const file = symbol?.declarations?.[0]?.getSourceFile()?.fileName;
  if (!file) return false;
  const resolved = path.resolve(file);
  return dirs.some((dir) => resolved.startsWith(dir));
}

function nullableRefAsAllOf(schema) {
  if (!schema || !schema.$ref || !schema.nullable) return schema;
  const { $ref, nullable, ...rest } = schema;
  return { ...rest, allOf: [{ $ref }], nullable };
}

/**
 * A field whose name ends in `Kobo` is an integer number of kobo, everywhere
 * (docs/contract/CONVENTIONS.md section 1), but TypeScript has one `number`
 * and the checker cannot say which. The name is the contract, so the schema
 * says `integer`. The wire is unchanged, and openapi-typescript generates
 * `number` for both, so no generated client type changes.
 */
function koboAsInteger(name, schema) {
  if (!name.endsWith('Kobo') || !schema || schema.type !== 'number') return schema;
  return { ...schema, type: 'integer' };
}

/** Promise<T> -> T, then Paginated<T>/PaginatedListResponse<T> -> T[]. */
function unwrapReturn(type) {
  let current = type;
  const name = current.getSymbol()?.getName();
  if (name === 'Promise') {
    const [inner] = typeArgsOf(checker, current);
    if (inner) current = inner;
  }
  const alias = current.aliasSymbol?.getName() ?? current.getSymbol()?.getName();
  if (alias === 'Paginated' || alias === 'PaginatedListResponse') {
    const args = current.aliasTypeArguments ?? typeArgsOf(checker, current);
    if (args.length) {
      return { type: args[0], paginated: true };
    }
  }
  return { type: current, paginated: false };
}

function main() {
  if (!fs.existsSync(SPEC)) {
    console.error(`No spec at ${SPEC}. Run the emitter first.`);
    process.exit(1);
  }
  const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8'));

  const cfgPath = path.join(ROOT, 'tsconfig.json');
  const cfg = ts.readConfigFile(cfgPath, ts.sys.readFile).config;
  const parsed = ts.parseJsonConfigFileContent(cfg, ts.sys, ROOT);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  checker = program.getTypeChecker();

  let matched = 0;
  let unmatched = 0;
  const missing = [];

  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile) continue;
    if (!file.fileName.endsWith('.controller.ts')) continue;

    ts.forEachChild(file, (node) => {
      if (!ts.isClassDeclaration(node)) return;
      const classDec = decoratorsOf(node)
        .map(readDecorator)
        .find((d) => d && d.name === 'Controller');
      if (!classDec) return;
      const base = classDec.arg;

      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member)) continue;
        const decs = decoratorsOf(member).map(readDecorator).filter(Boolean);
        const http = decs.find((d) => HTTP_DECORATORS.has(d.name));
        if (!http) continue;

        const route = toOpenApiPath([GLOBAL_PREFIX, base, http.arg]);
        const verb = HTTP_DECORATORS.get(http.name);
        const op = spec.paths?.[route]?.[verb];
        if (!op) {
          unmatched++;
          missing.push(`${verb.toUpperCase()} ${route}`);
          continue;
        }

        const sig = checker.getSignatureFromDeclaration(member);
        if (!sig) continue;
        const { type: returnType, paginated } = unwrapReturn(
          checker.getReturnTypeOfSignature(sig),
        );

        let inner = toSchema(returnType, 0);
        if (inner === null) continue; // void: no body to describe
        if (
          route.startsWith(`${GLOBAL_PREFIX}/money/`) ||
          route.startsWith(`${GLOBAL_PREFIX}/legal/intake/assistant`)
        ) {
          inner = nullableRefAsAllOf(inner);
        }
        let schema = paginated ? { type: 'array', items: inner } : inner;
        // A list route that states its maximum (`@MaxItems(n)`, money
        // contract) carries it on the array.
        const max = op['x-wawu-max-items'];
        if (typeof max === 'number' && schema.type === 'array') {
          schema = { ...schema, maxItems: max };
        }

        for (const code of Object.keys(op.responses ?? {})) {
          if (!/^2/.test(code)) continue;
          op.responses[code] = {
            description: op.responses[code]?.description ?? '',
            content: { 'application/json': { schema } },
          };
        }
        matched++;
      }
    });
  }

  spec.components = spec.components ?? {};
  spec.components.schemas = { ...(spec.components.schemas ?? {}), ...schemas };

  fs.writeFileSync(SPEC, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');

  console.log(`enriched operations : ${matched}`);
  console.log(`unmatched routes    : ${unmatched}`);
  console.log(`named schemas added : ${Object.keys(schemas).length}`);
  console.log(`total schemas       : ${Object.keys(spec.components.schemas).length}`);
  if (missing.length) {
    console.log('\nroutes present in code but not in the spec:');
    missing.slice(0, 20).forEach((m) => console.log(`  ${m}`));
    if (missing.length > 20) console.log(`  ... and ${missing.length - 20} more`);
  }
}

main();
