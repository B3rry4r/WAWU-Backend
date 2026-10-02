import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import {
  DocumentBuilder,
  SwaggerModule,
  type OpenAPIObject,
  type OperationObject,
  type PathItemObject,
} from '@nestjs/swagger';
import { AppModule } from '../app.module';
import { MoneyContractModule } from '../money/money-contract.module';

/**
 * Emits the frozen API contract (openapi.json) that the web client generates
 * its types from. Run via `npm run contract:emit` AFTER `nest build`, because
 * the @nestjs/swagger CLI plugin that supplies DTO property metadata runs at
 * compile time — emitting from un-compiled source produces a spec with empty
 * request bodies.
 *
 * Preview mode matters: PrismaService.onModuleInit opens a real connection, so
 * a normal NestFactory.create would need a live database just to read route
 * metadata. `preview: true` builds the module graph without instantiating
 * providers or running lifecycle hooks, which is all Swagger needs.
 */
async function emit(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    preview: true,
    logger: false,
  });
  app.setGlobalPrefix('api/hub');

  const config = new DocumentBuilder()
    .setTitle('WAWU Hub API')
    .setDescription(
      [
        'The contract the WAWU web client generates its types from.',
        '',
        'ENVELOPE: every successful response is wrapped by ResponseInterceptor',
        'before it leaves the server. The schemas below describe the INNER',
        'payload, which is what a client sees after unwrapping:',
        '',
        '  plain      {statusCode, message, data: <schema>}',
        '  paginated  {statusCode, message, data: <schema>[],',
        '              pagination: {currentPage, nextPage, perPage, total}}',
        '',
        'The web client unwraps in apiFetch/apiFetchPaginated (src/lib/api/client.ts),',
        'so generated types intentionally describe the inner payload, not the envelope.',
      ].join('\n'),
    )
    .setVersion('1.0.0')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      'wawu-id',
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);
  const declared = await addDeclaredRoutes(document, config);

  // cwd, not __dirname: `nest build` nests output under dist/src, so a path
  // relative to this file lands the contract inside dist/ and gets wiped by
  // the next build's deleteOutDir. The npm script always runs from the repo root.
  const out = resolve(process.cwd(), 'contract/openapi.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

  const paths = Object.keys(document.paths ?? {}).length;
  const schemas = Object.keys(document.components?.schemas ?? {}).length;
  console.log(
    `openapi.json written: ${paths} paths, ${schemas} schemas -> ${out}`,
  );
  console.log(
    `  of which declared, not served (x-wawu-served: false): ${declared} operations`,
  );

  await app.close();
}

/**
 * Routes that are part of the contract before anything serves them.
 *
 * MoneyContractModule (task MONEY-04) declares the Naira wallet routes so the
 * mobile app can generate its types and build its screens before the Fintava
 * client exists. AppModule does not import it, so the served document above
 * never sees it; this builds a second document from it, in the same preview
 * mode, and copies its operations and schemas in. Each copied operation is
 * marked `x-wawu-served: false` and keeps the `x-wawu-built-by` task its
 * declaration names, so a declared route is never mistaken for a live one.
 *
 * A route that is both served and declared fails the emit: the task that
 * serves a route deletes its declaration in the same change.
 */
async function addDeclaredRoutes(
  document: OpenAPIObject,
  config: Omit<OpenAPIObject, 'paths'>,
): Promise<number> {
  const declaredApp = await NestFactory.create(MoneyContractModule, {
    preview: true,
    logger: false,
  });
  declaredApp.setGlobalPrefix('api/hub');
  const declaredDoc = SwaggerModule.createDocument(declaredApp, config);
  await declaredApp.close();

  let count = 0;
  for (const [path, item] of Object.entries(declaredDoc.paths ?? {})) {
    const target = (document.paths[path] ??= {});
    for (const [method, op] of Object.entries(item)) {
      if (!isOperation(op)) continue;
      const key = method as keyof PathItemObject;
      if (target[key]) {
        throw new Error(
          `${method.toUpperCase()} ${path} is served and also declared in MoneyContractModule. Delete the declaration.`,
        );
      }
      const builtBy: unknown = (op as unknown as Record<string, unknown>)[
        'x-wawu-built-by'
      ];
      const note = `Declared by MONEY-04, not served yet${typeof builtBy === 'string' ? `: ${builtBy} serves it` : ''}.`;
      Object.assign(target, {
        [key]: {
          ...op,
          description: op.description ? `${note}\n\n${op.description}` : note,
          'x-wawu-served': false,
        },
      });
      count++;
    }
  }

  const schemas = declaredDoc.components?.schemas ?? {};
  document.components ??= {};
  document.components.schemas ??= {};
  for (const [name, schema] of Object.entries(schemas)) {
    const served = document.components.schemas[name];
    if (served) {
      // A served money route and a declared one share the contract's own
      // classes (MoneyErrorEnvelope, the PIN DTOs once MONEY-09 serves the
      // PIN): the same class emits the same schema, and one copy is kept. A
      // different schema under the same name is still a collision.
      if (JSON.stringify(served) === JSON.stringify(schema)) continue;
      throw new Error(
        `Schema ${name} is defined by a served route and by MoneyContractModule, differently. Rename one of them.`,
      );
    }
    document.components.schemas[name] = schema;
  }
  return count;
}

function isOperation(value: unknown): value is OperationObject {
  return typeof value === 'object' && value !== null && 'responses' in value;
}

emit().catch((err) => {
  console.error(err);
  process.exit(1);
});
