// Points the Hub's Nuvion calls at the stack's local Nuvion stand-in (STACK-NUV). Preloaded into the Hub by
// scripts/dev/stack.sh (node --require) AFTER block-net.cjs, so this wrapper runs first and block-net.cjs sees
// only the rewritten, local address.
//
// The Hub refuses any NUVION_BASE_URL but Nuvion's two documented hosts (src/nuvion/nuvion-config.ts), so the stack
// sets the sandbox host and this file sends every request to that one host to 127.0.0.1:<stand-in port> instead.
// Nothing is sent to the real host. Nuvion's production host is not rewritten: block-net.cjs refuses it.
// Without STACK_NUVION_STANDIN_PORT this file does nothing.
'use strict';

const PORT = process.env.STACK_NUVION_STANDIN_PORT;
const FROM = 'api.nuvion.dev';

if (PORT && /^\d+$/.test(PORT)) {
  const rewrite = (value) => {
    try {
      const u = new URL(typeof value === 'string' ? value : value.href || value.url);
      if (u.hostname !== FROM) return null;
      return new URL(`http://127.0.0.1:${PORT}${u.pathname}${u.search}`);
    } catch {
      return null;
    }
  };

  const realFetch = globalThis.fetch;
  if (typeof realFetch === 'function') {
    globalThis.fetch = (input, init) => {
      const local = rewrite(input);
      if (local === null) return realFetch(input, init);
      // A Request carries its own method, headers and body; a URL or a string takes them from init.
      if (typeof input === 'object' && input !== null && typeof input.method === 'string' && !(input instanceof URL)) {
        return realFetch(new Request(local, input), init);
      }
      return realFetch(local, init);
    };
  }
}
