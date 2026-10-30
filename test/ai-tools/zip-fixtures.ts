import { deflateRawSync } from 'node:zlib';
import { crc32 } from '../../src/ai-tools/music/zip-reader';

/** One entry of a test archive. `declared`, `crc`, `packed` and `flags` let a spec write a header that lies. */
export interface ZipEntrySpec {
  name: string;
  data: Buffer;
  method?: 'store' | 'deflate';
  declared?: number;
  crc?: number;
  packed?: Buffer;
  flags?: number;
}

/** A ZIP archive built in memory (no file on disk, no `zip` binary). Overlapping entries are made with `shareWithPrevious`. */
export function zipOf(
  entries: ZipEntrySpec[],
  opts: { shareWithPrevious?: boolean } = {},
): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  let previousStart = 0;
  entries.forEach((e, i) => {
    const name = Buffer.from(e.name, 'utf8');
    const packed =
      e.packed ?? (e.method === 'deflate' ? deflateRawSync(e.data) : e.data);
    const method = e.method === 'deflate' ? 8 : 0;
    const size = e.declared ?? e.data.length;
    const crc = e.crc ?? crc32(e.data);
    const flags = e.flags ?? 0x800;
    const start = opts.shareWithPrevious && i > 0 ? previousStart : offset;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(start, 42);
    centrals.push(central, name);
    if (!(opts.shareWithPrevious && i > 0)) {
      locals.push(local, name, packed);
      previousStart = offset;
      offset += 30 + name.length + packed.length;
    }
  });
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
