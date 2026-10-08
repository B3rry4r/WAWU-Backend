import {
  BadRequestException,
  Body,
  Controller,
  Get,
  INestApplication,
  Module,
  Param,
  ParseUUIDPipe,
  PipeTransform,
  Post,
  Query,
  Type,
  ValidationPipe,
} from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import type { Server } from 'node:http';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import {
  firstUnstorableField,
  isStorableText,
  unstorableTextMessage,
} from '../storable-text';
import {
  checkStorableTextOnEveryRoute,
  STORABLE_TEXT_PIPE,
} from '../storable-text.pipe';
import { UNSEARCHABLE_QUERY_MESSAGE } from '../../search-response/searchable-query';

/**
 * FIX-17. A query or path value Postgres cannot take (a NUL, or a lone
 * surrogate) is a 400 naming the field on every route, after every check
 * that already refused it, and nothing else changes.
 *
 * Two apps are built here from two copies of the same controller, one with
 * the check and one without (the app as it was before this task), both the
 * way src/main.ts builds the Hub. Every request that does not end in this
 * task's refusal must get the same bytes from both. The Hub's own routes are
 * in storable-text-hub.contract.spec.ts.
 */

const refusal = (field: string) => ({
  statusCode: 400,
  message: `${field} must have text in it, with no null characters or broken characters`,
  data: null,
});

class ProbeQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(10)
  q?: string;

  @IsOptional()
  @IsIn(['a', 'b'])
  tab?: string;

  @IsOptional()
  @IsString({ each: true })
  tags?: string[];
}

class ProbeBodyDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsIn(['x', 'y'])
  kind?: string;
}

/** Throws in the same turn, as TgifDatePipe does (ParseUUIDPipe is async). */
class DayPipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
      throw new BadRequestException('date must be a day written YYYY-MM-DD');
    return value;
  }
}

/** A fresh controller class each call, so one app can carry the check and the other not. */
function probeModule(calls: string[]): Type<unknown> {
  @Controller('probe')
  class ProbeController {
    @Get('uuid/:id')
    uuid(
      @Param('id', ParseUUIDPipe) id: string,
      @Query() query: ProbeQueryDto,
    ) {
      calls.push('uuid');
      return { id, q: query.q ?? null };
    }

    @Post('uuid/:id')
    uuidWrite(
      @Param('id', ParseUUIDPipe) id: string,
      @Body() body: ProbeBodyDto,
    ) {
      calls.push('uuidWrite');
      return { id, name: body.name };
    }

    @Post('day/:date')
    dayWrite(
      @Param('date', new DayPipe()) date: string,
      @Body() body: ProbeBodyDto,
    ) {
      calls.push('dayWrite');
      return { date, name: body.name };
    }

    @Get('named')
    named(@Query('page') page?: string, @Query('take') take?: string) {
      calls.push('named');
      return { page: page ?? null, take: take ?? null };
    }

    @Get('params/:a/:b')
    params(@Param() params: Record<string, string>) {
      calls.push('params');
      return params;
    }

    @Get(':id')
    one(@Param('id') id: string, @Query() query: ProbeQueryDto) {
      calls.push('one');
      return { id, q: query.q ?? null, tab: query.tab ?? null };
    }

    @Post(':id')
    write(@Param('id') id: string, @Body() body: ProbeBodyDto) {
      calls.push('write');
      return { id, name: body.name };
    }
  }

  @Module({ controllers: [ProbeController] })
  class ProbeModule {}
  return ProbeModule;
}

async function buildApp(
  calls: string[],
  withCheck: boolean,
): Promise<{
  app: INestApplication;
  controller: Type<unknown>;
}> {
  const mod = probeModule(calls);
  const moduleRef = await Test.createTestingModule({
    imports: [mod],
  }).compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/hub');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  if (withCheck) {
    checkStorableTextOnEveryRoute(app);
    // A second call adds nothing.
    checkStorableTextOnEveryRoute(app);
  }
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new ResponseInterceptor());
  await app.init();
  const controller = (
    Reflect.getMetadata('controllers', mod) as Type<unknown>[]
  )[0];
  return { app, controller };
}

type Probe = [method: 'GET' | 'POST', path: string, body?: object];

describe('Text Postgres cannot take, in a query or path value (FIX-17)', () => {
  describe('the rule', () => {
    it('refuses a NUL and a lone surrogate, anywhere in the value', () => {
      for (const bad of [
        '\u0000',
        'a\u0000b',
        `${'x'.repeat(99)}\u0000`,
        `${'y'.repeat(5000)}\u0000`,
        ' \u0000 ',
        '\uD800',
        'a\uDC00',
        `${'z'.repeat(120)}\uDBFF`,
        '\uDC00\uD800',
      ]) {
        expect(isStorableText(bad)).toBe(false);
      }
    });

    it('takes blank text, a whole surrogate pair and every other character', () => {
      for (const good of [
        '',
        ' ',
        'café',
        '�',
        '￾￿',
        '\u0001\u001F\u007F',
        '😀',
        '100% _off_ \\',
        'x'.repeat(5000),
      ]) {
        expect(isStorableText(good)).toBe(true);
      }
    });

    it('names the argument, or the key of a whole query or params object', () => {
      expect(firstUnstorableField('a\u0000', 'id')).toBe('id');
      expect(firstUnstorableField(['a', '\u0000'], 'tag')).toBe('tag');
      expect(firstUnstorableField('fine', 'id')).toBeNull();
      expect(firstUnstorableField(undefined, 'page')).toBeNull();
      expect(firstUnstorableField(7, 'page')).toBeNull();
      expect(
        firstUnstorableField(
          { q: 'ok', tab: 'x\u0000', other: '\u0000' },
          undefined,
        ),
      ).toBe('tab');
      expect(firstUnstorableField({ tags: ['ok', '\uD800'] }, undefined)).toBe(
        'tags',
      );
      expect(firstUnstorableField({ q: 'ok', n: 3 }, undefined)).toBeNull();
      // Keys are never read: an undeclared key is the ValidationPipe's.
      expect(firstUnstorableField({ 'a\u0000b': 'ok' }, undefined)).toBeNull();
    });

    it('is one sentence, the one /search already answers for q', () => {
      expect(unstorableTextMessage('q')).toBe(UNSEARCHABLE_QUERY_MESSAGE);
      expect(unstorableTextMessage('wawuId')).toBe(refusal('wawuId').message);
    });

    it('refuses a lone surrogate handed to the pipe directly (it cannot arrive over HTTP)', async () => {
      const refused = (field: string) => ({
        response: { statusCode: 400, message: refusal(field).message },
      });
      await expect(
        Promise.resolve(
          STORABLE_TEXT_PIPE.transform('a\uD800', { type: 'query', data: 'q' }),
        ),
      ).rejects.toMatchObject(refused('q'));
      await expect(
        Promise.resolve(
          STORABLE_TEXT_PIPE.transform(
            { q: 'ok', tab: '\uDC00' },
            { type: 'query', data: undefined },
          ),
        ),
      ).rejects.toMatchObject(refused('tab'));
      await expect(
        Promise.resolve(
          STORABLE_TEXT_PIPE.transform('\u0000', { type: 'param', data: 'id' }),
        ),
      ).rejects.toMatchObject(refused('id'));
      expect(
        STORABLE_TEXT_PIPE.transform('ok', { type: 'param', data: 'id' }),
      ).toBe('ok');
      // A body, a file or a custom argument is handed back unread.
      const body = { name: '\u0000' };
      expect(STORABLE_TEXT_PIPE.transform(body, { type: 'body' })).toBe(body);
      expect(STORABLE_TEXT_PIPE.transform('\u0000', { type: 'custom' })).toBe(
        '\u0000',
      );
    });
  });

  describe('on an app built the way src/main.ts builds the Hub', () => {
    const calls: string[] = [];
    const plainCalls: string[] = [];
    let app: INestApplication;
    let plain: INestApplication;
    let controller: Type<unknown>;
    let plainController: Type<unknown>;

    beforeAll(async () => {
      ({ app, controller } = await buildApp(calls, true));
      ({ app: plain, controller: plainController } = await buildApp(
        plainCalls,
        false,
      ));
    });

    afterAll(async () => {
      await app.close();
      await plain.close();
    });

    beforeEach(() => {
      calls.length = 0;
      plainCalls.length = 0;
    });

    const send = (target: INestApplication, [method, path, body]: Probe) => {
      const server = target.getHttpServer() as Server;
      const r =
        method === 'GET'
          ? request(server).get(`/api/hub${path}`)
          : request(server).post(`/api/hub${path}`);
      return body === undefined ? r : r.send(body);
    };
    const get = (path: string) => send(app, ['GET', path]);

    /** Same status and same bytes from the app with the check and the app without it. */
    async function expectUnchanged(probes: Probe[]): Promise<void> {
      for (const p of probes) {
        const [a, b] = [await send(app, p), await send(plain, p)];
        expect([p, a.status, a.text]).toEqual([p, b.status, b.text]);
      }
    }

    it('puts the check last on every argument, once, and leaves the app without it alone', () => {
      const pipesOf = (cls: Type<unknown>, method: string) =>
        Object.values(
          Reflect.getMetadata(ROUTE_ARGS_METADATA, cls, method) as Record<
            string,
            { pipes: unknown[] }
          >,
        ).map((arg) => arg.pipes);
      for (const method of [
        'uuid',
        'uuidWrite',
        'dayWrite',
        'named',
        'params',
        'one',
        'write',
      ]) {
        for (const pipes of pipesOf(controller, method)) {
          expect(pipes.filter((p) => p === STORABLE_TEXT_PIPE)).toHaveLength(1);
          expect(pipes[pipes.length - 1]).toBe(STORABLE_TEXT_PIPE);
        }
        for (const pipes of pipesOf(plainController, method))
          expect(pipes).not.toContain(STORABLE_TEXT_PIPE);
      }
    });

    it('refuses a NUL in a path value with 400 naming it, and the handler never runs', async () => {
      for (const v of ['%00', 'a%00b', 'abc%00', '%00%00']) {
        expect((await get(`/probe/${v}`).expect(400)).body).toEqual(
          refusal('id'),
        );
        // Without the check the handler ran with the NUL (on the Hub, the
        // query then failed with a 500).
        await send(plain, ['GET', `/probe/${v}`]).expect(200);
      }
      expect((await get('/probe/params/ok/x%00').expect(400)).body).toEqual(
        refusal('b'),
      );
      expect(calls).toEqual([]);
    });

    it('refuses a NUL in a query value, in a DTO or read by name, wherever it sits', async () => {
      for (const v of ['%00', 'a%00b', '%00%20', '%20%00']) {
        expect((await get(`/probe/x?q=${v}`).expect(400)).body).toEqual(
          refusal('q'),
        );
        expect((await get(`/probe/named?take=${v}`).expect(400)).body).toEqual(
          refusal('take'),
        );
      }
      expect((await get('/probe/x?tags=ok&tags=%00').expect(400)).body).toEqual(
        refusal('tags'),
      );
      expect(
        (await get('/probe/named?page=1&take=a%00').expect(400)).body,
      ).toEqual(refusal('take'));
      expect(calls).toEqual([]);
    });

    it('answers every clean value exactly as before, the handler running once each', async () => {
      const clean: Probe[] = [
        ['GET', '/probe/x?q=caf%C3%A9&tab=a'],
        ['GET', '/probe/x?tags=a&tags=b'],
        // Blank, a control character, U+FFFD (what Express makes of broken
        // UTF-8 and of a percent-encoded surrogate) all reach the handler.
        ...['', '%20', '%01', '%EF%BF%BD', '%ED%A0%80', '%C0%80'].map(
          (v): Probe => ['GET', `/probe/named?take=${v}`],
        ),
        ['GET', '/probe/params/a/b'],
        ['GET', '/probe/uuid/00000000-0000-4000-8000-000000000001?q=a'],
        [
          'POST',
          '/probe/uuid/00000000-0000-4000-8000-000000000001',
          { name: 'n' },
        ],
        ['POST', '/probe/day/2026-10-08', { name: 'n' }],
        // A body is never this check's business, NUL or not.
        ['POST', '/probe/a', { name: 'n\u0000' }],
        // Undeclared keys and paths no route serves.
        ['GET', '/probe/named?zz=%00'],
        ['GET', '/nothing-here/%00'],
      ];
      await expectUnchanged(clean);
      expect(calls).toEqual(plainCalls);
      expect(calls).toHaveLength(14);
    });

    it('keeps the 400 an earlier check gave a NUL, and every two-fault answer', async () => {
      await expectUnchanged([
        // The argument's own pipe answered first before FIX-17.
        ['GET', '/probe/uuid/%00'],
        ['GET', '/probe/uuid/a%00b?q=%00'],
        ['POST', '/probe/day/%00', { name: 'n' }],
        // The ValidationPipe on the same argument: too long, an unknown key.
        ['GET', `/probe/x?q=${'a'.repeat(11)}%00`],
        ['GET', '/probe/x?q=%00&zz=1'],
        // A NUL in one argument and a fault in another: the other answers.
        ['GET', '/probe/%00?zz=1'],
        ['GET', '/probe/%00?tab=c'],
        ['POST', '/probe/%00', {}],
        ['POST', '/probe/a%00b', { name: 'n', kind: 'z' }],
        // Two faults and no NUL: a bad path value against a bad body or
        // query, each in the order it answered before (a pipe that throws
        // at once, and one that answers a turn later).
        ['POST', '/probe/day/not-a-day', {}],
        ['POST', '/probe/day/not-a-day', { name: 'n', kind: 'z' }],
        ['POST', '/probe/uuid/not-a-uuid', {}],
        ['POST', '/probe/uuid/not-a-uuid', { name: 7 }],
        ['GET', '/probe/uuid/not-a-uuid?zz=1'],
        ['GET', '/probe/uuid/not-a-uuid?q=far-too-long-for-it'],
      ]);
      expect(calls).toEqual([]);
    });

    it('refuses a NUL path value on a write too, after the body is found good', async () => {
      const res = await send(app, [
        'POST',
        '/probe/a%00',
        { name: 'n' },
      ]).expect(400);
      expect(res.body).toEqual(refusal('id'));
      expect(calls).toEqual([]);
    });
  });
});
