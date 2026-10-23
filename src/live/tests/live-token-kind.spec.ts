import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import {
  ensureKeyPair,
  WawuIdDouble,
} from '../../../test/nuvion/wawu-id-double';
import { LiveTokenVerifier } from '../live-token.verifier';

/**
 * FIX-99 (H3): the live socket signs a person in with the same rule as every
 * REST route. A WAWU ID refresh token (`type: 'refresh'`, signed by the same
 * key) is not a session on the socket either; an access token is.
 */
const KID = 'mock-wawu-id-key-1';
const SUB = '00000000-0000-4000-8000-00000000f099';

describe('LiveTokenVerifier: only an access token signs a socket in (FIX-99)', () => {
  const wawuId = new WawuIdDouble();
  let verifier: LiveTokenVerifier;
  const { privateKey } = ensureKeyPair();

  const sign = (claims: Record<string, unknown>): string =>
    jwt.sign(claims, privateKey, {
      algorithm: 'RS256',
      keyid: KID,
      expiresIn: '15m',
    });

  beforeAll(async () => {
    await wawuId.start();
    verifier = new LiveTokenVerifier({
      get: (key: string) =>
        key === 'WAWU_ID_JWKS_URL' ? wawuId.jwksUrl : undefined,
    } as unknown as ConfigService);
  });

  afterAll(() => wawuId.stop());

  it('accepts an access token (no type)', async () => {
    const claims = await verifier.verify(
      sign({ sub: SUB, phone: '+2348000000001', status: 'active' }),
    );
    expect(claims.sub).toBe(SUB);
  });

  it('accepts a token that names itself an access token', async () => {
    const claims = await verifier.verify(sign({ sub: SUB, type: 'access' }));
    expect(claims.sub).toBe(SUB);
  });

  it('refuses a refresh token', async () => {
    await expect(
      verifier.verify(sign({ sub: SUB, jti: 'a-jti', type: 'refresh' })),
    ).rejects.toThrow('token is not an access token');
  });

  it('refuses a token of any other type', async () => {
    await expect(
      verifier.verify(sign({ sub: SUB, type: 'activation' })),
    ).rejects.toThrow('token is not an access token');
  });
});
