import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from '../app.module';

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

  // cwd, not __dirname: `nest build` nests output under dist/src, so a path
  // relative to this file lands the contract inside dist/ and gets wiped by
  // the next build's deleteOutDir. The npm script always runs from the repo root.
  const out = resolve(process.cwd(), 'contract/openapi.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

  const paths = Object.keys(document.paths ?? {}).length;
  const schemas = Object.keys(document.components?.schemas ?? {}).length;
  console.log(`openapi.json written: ${paths} paths, ${schemas} schemas -> ${out}`);

  await app.close();
}

emit().catch((err) => {
  console.error(err);
  process.exit(1);
});
