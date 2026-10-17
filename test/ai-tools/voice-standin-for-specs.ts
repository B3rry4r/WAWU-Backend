import type { Server } from 'http';

/** Starts the voice stand-in (scripts/dev/voice-standin.cjs) on a free port of 127.0.0.1 for a spec. */
export interface StandinHandle {
  server: Server;
  port: number;
  state: {
    calls: number;
    ok: number;
    failed: number;
    active: number;
    maxActive: number;
  };
}

type StandinModule = {
  startVoiceStandin: (o: {
    port: number;
    key: string;
  }) => Promise<StandinHandle>;
};

export function startStandin(key: string): Promise<StandinHandle> {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const mod = require('../../scripts/dev/voice-standin.cjs') as StandinModule;
  /* eslint-enable @typescript-eslint/no-require-imports */
  return mod.startVoiceStandin({ port: 0, key });
}
