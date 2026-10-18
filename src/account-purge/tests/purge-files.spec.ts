// FIX-65: every kind of file a person can upload has a decision at purge, and
// the table cannot fall behind the code that writes the files.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { UPLOAD_FOLDERS } from '../../storage/dto/presign-upload.dto';
import { CHAT_UPLOAD_FOLDERS } from '../../chat/chat-limits';
import { AI_AUDIO_FOLDER } from '../../ai-tools/audio/ai-audio-store';
import {
  EVENT_FOLDERS,
  FILE_KINDS,
  OWNER_FOLDERS,
  purgeNoteOf,
} from '../purge-files';

/**
 * Every way a file in this code can put an object in the bucket (FIX-65 I2,
 * and SWEEP-LATE V2: `@aws-sdk/lib-storage` `Upload` is a way too, and is
 * named by its package, because its class name is too common to search for).
 */
const BUCKET_WRITERS =
  'PutObjectCommand|CreateMultipartUploadCommand|createPresignedPost|UploadPartCommand|@aws-sdk/lib-storage';

/** The files under `dir` (not specs, not `tests/`) that match an extended regular expression. */
function filesMatching(pattern: string, dir: string): string[] {
  const found = spawnSync(
    'grep',
    [
      '-rlE',
      pattern,
      dir,
      '--include=*.ts',
      '--exclude=*.spec.ts',
      '--exclude-dir=tests',
    ],
    { encoding: 'utf8' },
  );
  return found.stdout
    .trim()
    .split('\n')
    .filter((f) => f !== '')
    .map((f) => relative(dir, f))
    .sort();
}

describe('FIX-65: what the purge does with each kind of upload', () => {
  const written = [
    ...UPLOAD_FOLDERS,
    ...CHAT_UPLOAD_FOLDERS,
    AI_AUDIO_FOLDER,
  ] as string[];

  it('decides every folder the Hub writes to, and names no folder it does not write to', () => {
    expect(Object.keys(FILE_KINDS).sort()).toEqual([...written].sort());
  });

  it('has no place that writes to the bucket besides the four this table covers', () => {
    // A new caller of putGenerated or presignUpload (or a new StorageObject
    // writer) may bring a folder of its own: it fails here until that folder
    // has a decision in FILE_KINDS and this list names the file.
    const src = join(__dirname, '../..');
    const found = spawnSync(
      'grep',
      [
        '-rlE',
        '\\.(putGenerated|presignUpload)\\(|storageObject\\.(create|createMany|upsert)\\(',
        src,
        '--include=*.ts',
        '--exclude=*.spec.ts',
        '--exclude-dir=tests',
      ],
      { encoding: 'utf8' },
    );
    expect(
      found.stdout
        .trim()
        .split('\n')
        .map((f) => relative(src, f))
        .sort(),
    ).toEqual([
      'ai-tools/audio/ai-audio-store.ts',
      'chat/chat.service.ts',
      'storage/storage.controller.ts',
      'storage/storage.service.ts',
    ]);
  });

  // FIX-65 I2: the test above greps the Hub's own writers; a file that talked
  // to S3 itself (its own PutObjectCommand) would pass it. Only
  // storage.service.ts may put an object, so a new file that does fails here
  // until its folder has a decision in FILE_KINDS and this list names it.
  it('has no file that puts an object in the bucket besides storage.service.ts', () => {
    expect(filesMatching(BUCKET_WRITERS, join(__dirname, '../..'))).toEqual([
      'storage/storage.service.ts',
    ]);
  });

  // SWEEP-LATE V2: the guard above passes on the code as it stands, so it
  // proves nothing until a file that does the thing is put in front of it.
  // Each way of putting an object is planted in a folder of its own here, and
  // the guard must name that file.
  it('names a planted file for each way of putting an object in the bucket', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wawu-purge-guard-'));
    try {
      const ways: Array<[string, string]> = [
        ['put.ts', "new PutObjectCommand({ Bucket: 'b', Key: 'k' });"],
        ['multipart.ts', 'new CreateMultipartUploadCommand({});'],
        ['post.ts', 'await createPresignedPost(client, {});'],
        ['part.ts', 'new UploadPartCommand({});'],
        [
          'lib.ts',
          "import { Upload } from '@aws-sdk/lib-storage'; new Upload({});",
        ],
      ];
      mkdirSync(join(dir, 'planted'));
      for (const [name, text] of ways) {
        writeFileSync(join(dir, 'planted', name), text);
      }
      writeFileSync(join(dir, 'planted', 'harmless.ts'), 'export const a = 1;');
      expect(filesMatching(BUCKET_WRITERS, dir)).toEqual(
        ways.map(([name]) => `planted/${name}`).sort(),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps for the owner exactly the identity and verification folders', () => {
    expect([...OWNER_FOLDERS].sort()).toEqual([
      'kyc/id-document',
      'professional/document',
      'service-application/document',
    ]);
  });

  it('knows the folders an event image can come from', () => {
    for (const f of EVENT_FOLDERS) expect(FILE_KINDS[f]).toBeDefined();
  });

  it('writes no em-dash in what a person or the owner reads', () => {
    for (const kind of Object.values(FILE_KINDS)) {
      expect(kind.what).not.toContain('—');
      expect(kind.what.length).toBeGreaterThan(10);
    }
    const note = purgeNoteOf({
      keptForBuyers: 1,
      files: { ownerKept: 2, eventKept: 3 },
    });
    expect(note).not.toContain('—');
  });

  it('says nothing when nothing was kept, and keeps the buyers wording as it was', () => {
    expect(
      purgeNoteOf({ keptForBuyers: 0, files: { ownerKept: 0, eventKept: 0 } }),
    ).toBeNull();
    expect(
      purgeNoteOf({ keptForBuyers: 2, files: { ownerKept: 0, eventKept: 0 } }),
    ).toBe(
      '2 content piece(s) that buyers paid for were kept hidden and anonymised',
    );
    expect(
      purgeNoteOf({ keptForBuyers: 0, files: { ownerKept: 3, eventKept: 0 } }),
    ).toBe("3 identity or verification file(s) kept for the owner's ruling");
  });
});
