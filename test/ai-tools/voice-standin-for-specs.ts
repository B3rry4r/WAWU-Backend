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
    /** Each Sound effect call: the `duration_seconds` asked (null when none). */
    sfx: (number | null)[];
    /** Each Music call: the `music_length_ms` asked (null when none) and whether it was instrumental. */
    music: { lengthMs: number | null; instrumental: boolean }[];
    /** Each speech to text call (AITOOLS-04): the model, the language asked, the timestamps asked, the file's bytes and type. */
    transcribe: {
      model: string;
      languageCode: string | null;
      granularity: string | null;
      bytes: number;
      fileType: string | null;
    }[];
    /** Each audio isolation call: the file's bytes and type. */
    isolate: { bytes: number; fileType: string | null }[];
    deletedTranscripts: string[];
    deletedIsolations: string[];
    /** Every delete try on a provider copy and the status it got (404 while the copy is not stored yet). */
    deleteTries: {
      kind: 'transcript' | 'isolation';
      id: string;
      status: number;
      /** True when the provider answered 2xx and left the copy there (`[[ack-then-appear:MS]]`). */
      kept?: boolean;
    }[];
    /** Every read of a transcript copy by id and the status it got (round 3). */
    reads: { kind: 'transcript'; id: string; status: number }[];
  };
  /** Transcripts and cleaned recordings the provider still holds. */
  openTranscripts: () => number;
  openIsolations: () => number;
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
