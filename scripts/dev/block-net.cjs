// Nothing may leave this machine. Preloaded into the Hub and wawu-id by
// scripts/dev/stack.sh (node --require): any request to a host that is not this
// machine is refused and named in the service log. It covers global fetch and
// the http and https clients, which is every way these services call out.
'use strict';

const LOCAL = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

function refuse(kind, host) {
  console.log(`[block-net] refused ${kind} to ${host || '?'}`);
  return new Error(`block-net: ${host || 'unknown host'} is not this machine`);
}

function hostOf(value) {
  try {
    return new URL(typeof value === 'string' ? value : (value && (value.href || value.url))).hostname;
  } catch {
    return '';
  }
}

const realFetch = globalThis.fetch;
if (typeof realFetch === 'function') {
  globalThis.fetch = (input, init) => {
    const host = hostOf(input);
    if (!LOCAL.has(host)) return Promise.reject(refuse('fetch', host));
    return realFetch(input, init);
  };
}

for (const name of ['http', 'https']) {
  const mod = require(name);
  for (const method of ['request', 'get']) {
    const real = mod[method];
    mod[method] = function (...args) {
      const first = args[0];
      let host = '';
      if (typeof first === 'string' || first instanceof URL) {
        host = hostOf(first);
      } else if (first && typeof first === 'object') {
        host = String(first.hostname || first.host || 'localhost').replace(/:\d+$/, '');
      }
      if (!LOCAL.has(host)) throw refuse(`${name} ${method}`, host);
      return real.apply(this, args);
    };
  }
}
