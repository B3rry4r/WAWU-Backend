import { spawn } from 'node:child_process';
import { createHash, createPublicKey } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * SWEEP-APP-7 (FIX-81 L2): several jest processes starting together on a fresh checkout must end with ONE key pair, the
 * private file and the public file from the same pair. The double used to write both files, one after the other, with no
 * lock, so a second process could overwrite the first's private key and every token was then refused (401 "pin not set").
 * The processes here are real ones, started together on an empty folder; they all wait for the same instant to start.
 */
const MODULE =
  process.env.KEYS_MODULE ??
  join(__dirname, '../../../test/nuvion/wawu-id-double');

const CHILD = `
const ts = require('typescript');
require.extensions['.ts'] = (mod, file) => {
  const out = ts.transpileModule(require('node:fs').readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  mod._compile(out.outputText, file);
};
const { createHash } = require('node:crypto');
const m = require(process.env.KEYS_MODULE);
while (Date.now() < Number(process.env.KEYS_START)) {}
const { privateKey } = (m.ensureKeyPair ?? m.keyPair)(process.env.KEYS_DIR);
process.stdout.write(createHash('sha256').update(privateKey).digest('hex'));
`;

function child(dir: string, start: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['-e', CHILD], {
      env: {
        ...process.env,
        KEYS_MODULE: MODULE,
        KEYS_DIR: dir,
        KEYS_START: String(start),
      },
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d: Buffer) => (out += d.toString()));
    p.stderr.on('data', (d: Buffer) => (err += d.toString()));
    p.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(err)),
    );
  });
}

describe('The WAWU ID double makes one key pair, however many processes start together (FIX-81 L2)', () => {
  it.each([1, 2, 3])(
    'round %i: eight processes on an empty folder all get the same private key, and the public file is its pair',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'wawu-id-keys-'));
      try {
        const start = Date.now() + 3000;
        const seen = await Promise.all(
          Array.from({ length: 8 }, () => child(dir, start)),
        );
        const kept = readFileSync(join(dir, 'private.pem'), 'utf8');
        expect(new Set(seen)).toEqual(
          new Set([createHash('sha256').update(kept).digest('hex')]),
        );
        const derived = createPublicKey(kept)
          .export({ type: 'spki', format: 'pem' })
          .toString();
        expect(readFileSync(join(dir, 'public.pem'), 'utf8')).toBe(derived);
        // Nothing is left behind but the two files.
        expect(readdirSync(dir).sort()).toEqual(['private.pem', 'public.pem']);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
