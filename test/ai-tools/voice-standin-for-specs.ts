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
    /** The `model_id` of each speech call, in order (null when none was sent). */
    models: (string | null)[];
    lastModel: string | null;
    cloned: number;
    deleted: number;
  };
  /** Voices the stand-in made for a person's own sample and has not yet had removed. */
  openClones: () => number;
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
  return mod.startVoiceStandin({
    port: Number(process.env.VOICE_STANDIN_PORT ?? 0),
    key,
  });
}
