import { Controller, Get, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureHubApp } from '../hub-app-config';

@Controller('cors-probe')
class CorsProbeController {
  @Get()
  read() {
    return { ok: true };
  }
}

/**
 * WEBAPP-03: a browser hides every response header a server has not exposed, so the web app could not read
 * `Retry-After` on a 429. The Hub exposes it, and only that, on top of the CORS answer it already gave.
 */
describe('Hub CORS: Retry-After is exposed to a browser page', () => {
  let app: INestApplication;
  const saved = process.env.CORS_ORIGIN;

  beforeAll(async () => {
    process.env.CORS_ORIGIN = 'https://web.example.test';
    const module = await Test.createTestingModule({
      controllers: [CorsProbeController],
    }).compile();
    app = module.createNestApplication();
    configureHubApp(app);
    await app.init();
  });
  afterAll(async () => {
    if (saved === undefined) delete process.env.CORS_ORIGIN;
    else process.env.CORS_ORIGIN = saved;
    await app.close();
  });

  it('answers a listed origin with Access-Control-Expose-Headers: Retry-After', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/hub/cors-probe')
      .set('Origin', 'https://web.example.test');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(
      'https://web.example.test',
    );
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['access-control-expose-headers']).toBe('Retry-After');
  });

  it('still refuses to reflect an origin that is not listed', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/hub/cors-probe')
      .set('Origin', 'https://other.example.test');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
