import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import {
  existsSync,
  linkSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

/**
 * A local stand-in for WAWU ID (task NUV-01): the JWKS the Hub checks tokens
 * against, and the internal route that emails a PIN reset code
 * (`POST /internal/users/:userId/pin-reset-code`, BACKEND_GAPS G-400). It
 * signs with the same key file the mock WAWU ID uses
 * (`mock-wawu-id/private.pem`, made here the way the mock makes it when it
 * is missing), so the PIN harness's tokens (test/money/) verify against it.
 * Nothing leaves this machine.
 */
const KID = 'mock-wawu-id-key-1';
const DIR = join(__dirname, '../../mock-wawu-id');

/**
 * The key pair in `dir`, made when it is missing. Several jest processes can start together on a fresh checkout, so the
 * private key is put in place by a hard link that fails when another process got there first: one pair is ever kept, and
 * it is never overwritten (SWEEP-APP-7, FIX-81 L2). The public half is written by the process that won, through a rename,
 * and every reader here derives the public key from the private one anyway.
 */
export function ensureKeyPair(dir: string = DIR): {
  privateKey: string;
  publicKey: string;
} {
  const privPath = join(dir, 'private.pem');
  if (!existsSync(privPath)) {
    const pair = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const stamp = `${process.pid}-${Date.now()}`;
    const tmpPriv = join(dir, `.private-${stamp}.pem`);
    const tmpPub = join(dir, `.public-${stamp}.pem`);
    writeFileSync(tmpPriv, pair.privateKey);
    writeFileSync(tmpPub, pair.publicKey);
    try {
      linkSync(tmpPriv, privPath);
      renameSync(tmpPub, join(dir, 'public.pem'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    } finally {
      rmSync(tmpPriv, { force: true });
      rmSync(tmpPub, { force: true });
    }
  }
  const privateKey = readFileSync(privPath, 'utf8');
  const publicKey = createPublicKey(privateKey)
    .export({ type: 'spki', format: 'pem' })
    .toString();
  return { privateKey, publicKey };
}

export interface EmailedCode {
  userId: string;
  serviceKey: string | undefined;
  body: { code?: unknown; expiresInMinutes?: unknown };
}

export class WawuIdDouble {
  readonly emailed: EmailedCode[] = [];
  /** What the pin-reset-code route answers next (default 200). */
  answer: { status: number; delayMs?: number } = { status: 200 };
  private server: Server | null = null;
  private port = 0;
  private readonly publicKey = ensureKeyPair().publicKey;

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get jwksUrl(): string {
    return `${this.baseUrl}/.well-known/jwks.json`;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const url = req.url ?? '/';
        if (req.method === 'GET' && url === '/.well-known/jwks.json') {
          const jwk = createPublicKey(this.publicKey).export({ format: 'jwk' });
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              keys: [{ ...jwk, kid: KID, use: 'sig', alg: 'RS256' }],
            }),
          );
          return;
        }
        const m = /^\/internal\/users\/([^/]+)\/pin-reset-code$/.exec(url);
        if (req.method === 'POST' && m) {
          let body: EmailedCode['body'] = {};
          try {
            body = JSON.parse(
              Buffer.concat(chunks).toString('utf8'),
            ) as EmailedCode['body'];
          } catch {
            body = {};
          }
          this.emailed.push({
            userId: decodeURIComponent(m[1]),
            serviceKey: req.headers['x-service-key'] as string | undefined,
            body,
          });
          const { status, delayMs } = this.answer;
          const send = () => {
            res.statusCode = status;
            res.setHeader('Content-Type', 'application/json');
            res.end(
              JSON.stringify(
                status < 300 ? { data: { sent: true } } : { message: 'no' },
              ),
            );
          };
          if (delayMs) setTimeout(send, delayMs).unref();
          else send();
          return;
        }
        res.statusCode = 404;
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) =>
      this.server!.listen(0, '127.0.0.1', () => resolve()),
    );
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }
}
