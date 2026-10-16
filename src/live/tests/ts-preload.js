// Preloads TypeScript for the shutdown test's child process (task INBOX-02).
// The generated Prisma client imports its own files as './x.js' while they are
// './x.ts' on disk; Jest maps that, plain Node does not, so it is mapped here.
const Module = require('module');
const fs = require('fs');
const path = require('path');
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (
    request.startsWith('.') &&
    request.endsWith('.js') &&
    parent &&
    parent.filename
  ) {
    const asJs = path.resolve(path.dirname(parent.filename), request);
    if (!fs.existsSync(asJs)) {
      const asTs = asJs.slice(0, -3) + '.ts';
      if (fs.existsSync(asTs)) return resolve.call(this, asTs, parent, ...rest);
    }
  }
  return resolve.call(this, request, parent, ...rest);
};
require('ts-node/register/transpile-only');
