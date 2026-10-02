#!/usr/bin/env node
/*
 * Reads and writes the .env files scripts/local/up.sh manages, the way the
 * services read them.
 *
 *   node scripts/local/envfile.js get  FILE KEY        prints the value dotenv resolves
 *   node scripts/local/envfile.js keys FILE            prints every key, one per line
 *   node scripts/local/envfile.js set  FILE KEY VALUE  makes VALUE the only definition of KEY
 *
 * "The way the services read them" matters: Nest's ConfigModule, Prisma's
 * config and the seed all load the file with dotenv, which accepts
 * `export KEY=...`, indented lines and spaces around `=`, and lets a later
 * line win. A grep for `^KEY=` sees none of that, so a safety check built on
 * one can be walked past. Every read here goes through the dotenv of the
 * repo that owns the file (falling back to this repo's), so the check sees
 * exactly the value the service will use.
 */
const fs = require('fs');
const path = require('path');

function loadDotenv(file) {
  const tries = [path.dirname(path.resolve(file)), path.resolve(__dirname, '..', '..')];
  for (const dir of tries) {
    try {
      return require(require.resolve('dotenv', { paths: [dir] }));
    } catch {
      // try the next location
    }
  }
  throw new Error(`dotenv is not installed (looked from ${tries.join(' and ')}). Run npm ci first.`);
}

function parse(file) {
  return loadDotenv(file).parse(fs.readFileSync(file));
}

function keyLine(key) {
  // Any line dotenv would read as a definition of KEY.
  return new RegExp(`^[ \\t]*(?:export[ \\t]+)?${key.replace(/[.]/g, '\\.')}[ \\t]*[=:]`);
}

function set(file, key, value) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const re = keyLine(key);
  const out = [];
  let placed = false;
  for (const line of lines) {
    if (re.test(line)) {
      if (!placed) out.push(`${key}=${value}`);
      placed = true;
      continue;
    }
    out.push(line);
  }
  if (!placed) {
    if (out.length && out[out.length - 1] === '') out.pop();
    out.push(`${key}=${value}`, '');
  }
  fs.writeFileSync(file, out.join('\n'));
  // Prove the write landed the way dotenv will read it.
  const want = value.replace(/^"(.*)"$/, '$1');
  if (parse(file)[key] !== want) {
    throw new Error(`${file}: ${key} did not read back as written`);
  }
}

const [cmd, file, key, value] = process.argv.slice(2);
try {
  if (cmd === 'get') {
    const v = parse(file)[key];
    process.stdout.write(v === undefined ? '' : v);
  } else if (cmd === 'keys') {
    process.stdout.write(Object.keys(parse(file)).join('\n'));
  } else if (cmd === 'set' && key && value !== undefined) {
    set(file, key, value);
  } else {
    throw new Error('usage: envfile.js get FILE KEY | keys FILE | set FILE KEY VALUE');
  }
} catch (err) {
  console.error(err.message || err);
  process.exit(1);
}
