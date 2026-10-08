import {
  ArgumentsHost,
  BadRequestException,
  HttpStatus,
  Logger,
  PayloadTooLargeException,
} from '@nestjs/common';
import { AllExceptionsFilter } from '../all-exceptions.filter';

/**
 * FIX-08, the filter on its own: which errors it answers as the body
 * parser's 4xx, and which it leaves exactly as they were.
 *
 * The errors are built in the shape `http-errors` gives them (body-parser and
 * raw-body raise nothing else): `status` and `statusCode` the same number,
 * `expose` true for a 4xx, and body-parser's `type`. The real parser, through
 * the real app, is in body-parser-refusals.contract.spec.ts.
 */

type Answer = { status: number; body: Record<string, unknown> };

function answer(exception: unknown): Answer {
  const out: Answer = { status: 0, body: {} };
  const response = {
    status(code: number) {
      out.status = code;
      return response;
    },
    json(body: Record<string, unknown>) {
      out.body = body;
      return response;
    },
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost;
  new AllExceptionsFilter().catch(exception, host);
  return out;
}

/** An error as http-errors builds it. */
function httpError(
  status: number,
  message: string,
  props: { type?: string; expose?: boolean; statusCode?: number } = {},
): Error {
  return Object.assign(new Error(message), {
    status,
    statusCode: props.statusCode ?? status,
    expose: props.expose ?? status < 500,
    ...(props.type === undefined ? {} : { type: props.type }),
  });
}

const GENERIC_500 = {
  statusCode: 500,
  message: 'Something went wrong. Please try again.',
  data: null,
};

describe('AllExceptionsFilter: body parser refusals (FIX-08)', () => {
  let logged: jest.SpyInstance;
  let warned: jest.SpyInstance;

  beforeEach(() => {
    logged = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    warned = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    logged.mockRestore();
    warned.mockRestore();
  });

  describe('a caller whose body the parser refuses gets its 4xx, in the usual envelope', () => {
    const cases: Array<[string, Error, number, string]> = [
      [
        'too large',
        httpError(413, 'request entity too large', {
          type: 'entity.too.large',
        }),
        413,
        'That request is too large.',
      ],
      [
        'too many form fields',
        httpError(413, 'too many parameters', { type: 'parameters.too.many' }),
        413,
        'That request has too many fields.',
      ],
      [
        'a charset other than UTF-8',
        httpError(415, 'unsupported charset "LATIN1"', {
          type: 'charset.unsupported',
        }),
        415,
        'That request uses a character set this server does not read. Send it as UTF-8.',
      ],
      [
        'a content encoding the parser cannot undo',
        httpError(415, 'unsupported content encoding "bogus"', {
          type: 'encoding.unsupported',
        }),
        415,
        'That request uses a content encoding this server does not read.',
      ],
      [
        'a gzip stream that is not gzip (no type, as raw-body passes zlib errors on)',
        httpError(400, 'incorrect header check'),
        400,
        'That request could not be read.',
      ],
      [
        'a form nested too deep',
        httpError(400, 'The input exceeded the depth', {
          type: 'querystring.parse.rangeError',
        }),
        400,
        'That request could not be read.',
      ],
      [
        'a body shorter than its Content-Length',
        httpError(400, 'request size did not match content length', {
          type: 'request.size.invalid',
        }),
        400,
        'That request could not be read.',
      ],
      [
        'a 413 of a type this filter has no sentence for',
        httpError(413, 'something new', { type: 'entity.something.new' }),
        413,
        'That request is too large.',
      ],
      [
        'a 415 of a type this filter has no sentence for',
        httpError(415, 'something new', { type: 'media.something.new' }),
        415,
        'That request is in a format this server does not read.',
      ],
    ];

    it.each(cases)('%s', (_name, error, status, message) => {
      const out = answer(error);
      expect(out.status).toBe(status);
      expect(out.body).toEqual({ statusCode: status, message, data: null });
    });

    it("none of them is logged as a server error: the mistake is the caller's", () => {
      for (const [, error] of cases) answer(error);
      expect(logged).not.toHaveBeenCalled();
      expect(warned).not.toHaveBeenCalled();
    });

    it('the parser text, which echoes the caller headers, is never sent', () => {
      const out = answer(
        httpError(415, 'unsupported charset "<SCRIPT>"', {
          type: 'charset.unsupported',
        }),
      );
      expect(JSON.stringify(out.body)).not.toContain('SCRIPT');
    });
  });

  describe('everything else answers exactly as before', () => {
    it('an http-errors shape that is not marked expose stays a 500', () => {
      const out = answer(
        httpError(413, 'request entity too large', {
          type: 'entity.too.large',
          expose: false,
        }),
      );
      expect(out.status).toBe(500);
      expect(out.body).toEqual(GENERIC_500);
    });

    it('a status that disagrees with its statusCode stays a 500', () => {
      const out = answer(
        httpError(413, 'request entity too large', {
          type: 'entity.too.large',
          statusCode: 500,
        }),
      );
      expect(out.status).toBe(500);
      expect(out.body).toEqual(GENERIC_500);
    });

    it.each([
      [
        '403, a verify hook refusing (never thrown here)',
        403,
        'entity.verify.failed',
      ],
      ['404 from anything that is not the parser', 404, undefined],
      ['429', 429, undefined],
      ['500 stream not readable', 500, 'stream.not.readable'],
      ['500 stream encoding set', 500, 'stream.encoding.set'],
    ])('%s stays a 500', (_name, status, type) => {
      const out = answer(httpError(status, 'from a library', { type }));
      expect(out.status).toBe(500);
      expect(out.body).toEqual(GENERIC_500);
      expect(logged).toHaveBeenCalled();
    });

    it('a plain object with a 413 status (not an Error) stays a 500', () => {
      const out = answer({
        status: 413,
        statusCode: 413,
        expose: true,
        type: 'entity.too.large',
      });
      expect(out.status).toBe(500);
      expect(out.body).toEqual(GENERIC_500);
    });

    it('a plain Error stays a 500 and is logged', () => {
      const out = answer(new Error('database fell over'));
      expect(out.status).toBe(500);
      expect(out.body).toEqual(GENERIC_500);
      expect(logged).toHaveBeenCalledTimes(1);
    });

    it('malformed JSON keeps the 400 Nest already gives it, with the parser message', () => {
      // How Nest hands it over: RoutesResolver.mapExternalException turns
      // body-parser's SyntaxError into a BadRequestException(err.message).
      const out = answer(
        new BadRequestException('Unexpected end of JSON input'),
      );
      expect(out.status).toBe(400);
      expect(out.body).toEqual({
        statusCode: 400,
        message: 'Unexpected end of JSON input',
        data: null,
      });
    });

    it('a 413 a route throws itself (an HttpException) keeps its own message', () => {
      const out = answer(new PayloadTooLargeException('File too large'));
      expect(out.status).toBe(HttpStatus.PAYLOAD_TOO_LARGE);
      expect(out.body).toEqual({
        statusCode: 413,
        message: 'File too large',
        data: null,
      });
    });

    it('a Prisma unique violation is still a 409', () => {
      const out = answer(
        Object.assign(new Error('Unique constraint failed'), {
          name: 'PrismaClientKnownRequestError',
          code: 'P2002',
          clientVersion: '7.9.1',
        }),
      );
      expect(out.status).toBe(409);
      expect(out.body).toEqual({
        statusCode: 409,
        message: 'That record already exists.',
        data: null,
      });
    });
  });
});
