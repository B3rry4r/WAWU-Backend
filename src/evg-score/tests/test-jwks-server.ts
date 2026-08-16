import * as crypto from 'crypto';
import * as http from 'http';
import * as jwt from 'jsonwebtoken';

/**
 * In-process stand-in for WAWU ID's JWKS endpoint, scoped to this module's
 * own contract tests. Generates a real RSA keypair and serves it over real
 * HTTP so `WawuJwtStrategy` (jwks-rsa + passport-jwt, unmodified, imported
 * straight from src/common/auth) performs genuine signature verification —
 * nothing about auth is mocked/overridden, only the *issuer* is a local
 * stand-in (mirrors conventions.md § Local test environment's documented
 * "mock WAWU ID" pattern, kept self-contained here since this build agent's
 * scope is limited to src/evg-score/).
 */
export interface TestJwksServer {
  jwksUrl: string;
  signToken: (claims: Record<string, unknown>) => string;
  close: () => Promise<void>;
}

export async function startTestJwksServer(): Promise<TestJwksServer> {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const kid = 'evg-score-test-key-1';

  const server = http.createServer((req, res) => {
    if (req.url === '/.well-known/jwks.json') {
      const jwk = crypto.createPublicKey(publicKey).export({ format: 'jwk' }) as Record<string, unknown>;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ keys: [{ ...jwk, kid, use: 'sig', alg: 'RS256' }] }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind test JWKS server to a port');
  }

  return {
    jwksUrl: `http://127.0.0.1:${address.port}/.well-known/jwks.json`,
    signToken: (claims) =>
      jwt.sign(claims, privateKey, { algorithm: 'RS256', keyid: kid, expiresIn: '15m' }),
    close: () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
