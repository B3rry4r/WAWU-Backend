import { Inject, Injectable } from '@nestjs/common';
import {
  AI_AUDIO_STORE,
  audioKeyFor,
  type AiAudioStore,
} from '../ai-tools/audio/ai-audio-store';
import type { VoiceSample } from '../ai-tools/voice/ai-voice-provider';
import { deliverableKeyFrom, StorageService } from '../storage/storage.service';

/**
 * Where a person's voice files live (VOICE-01). One seam so a spec can run the
 * whole flow without a bucket; production is `StorageVoiceFiles`.
 *
 * The Hub's own audio (a Voice Intro, a name preview) is kept the way the AI
 * tools keep theirs: through `AI_AUDIO_STORE`, in the same folder, as the
 * person's own file. One writer to the bucket for everything the Hub makes.
 */
export const VOICE_FILES = Symbol('VOICE_FILES');

/** The folder of the 30 second recording (presign path). */
export const RECORDING_FOLDER = 'voice/sample';
/** The name a person's name preview is kept under: one file, replaced each time. */
export const NAME_PREVIEW_NAME = 'name-preview';

/** The most bytes of a sample the Hub will read for one run (the folder's upload cap). */
export const RECORDING_MAX_BYTES = 10 * 1024 * 1024;

export interface VoiceFiles {
  /**
   * The storage key a link from `POST /uploads/presign` stands for, or null
   * when the link is not one of THIS bucket's own (another host, a look-alike
   * host, userinfo, an escape or a backslash is null). Works the address out
   * locally; no network call.
   */
  keyFromLink(link: string): Promise<string | null>;
  /** The bytes of the person's stored recording. Throws when it cannot be read. */
  readSample(key: string): Promise<VoiceSample>;
  /** Keeps audio the Hub made as the person's own file and returns its key. The same name again replaces it. */
  putAudio(wawuUserId: string, name: string, audio: Buffer): Promise<string>;
  /** A link the app plays the audio from. */
  urlFor(key: string): Promise<string>;
  /** Drops a file (audio, or a sample that was replaced). Never throws. */
  remove(key: string): Promise<void>;
}

/** The key an intro run's audio is stored under: one per run, so a run can find it again without a column write. */
export function introAudioKey(wawuUserId: string, runId: string): string {
  return audioKeyFor(wawuUserId, runId);
}

@Injectable()
export class StorageVoiceFiles implements VoiceFiles {
  constructor(
    private readonly storage: StorageService,
    @Inject(AI_AUDIO_STORE) private readonly audio: AiAudioStore,
  ) {}

  async keyFromLink(link: string): Promise<string | null> {
    return deliverableKeyFrom(link, await this.storage.bucketLocation(), [
      RECORDING_FOLDER,
    ]);
  }

  readSample(key: string): Promise<VoiceSample> {
    return this.storage.readStored(key, RECORDING_MAX_BYTES);
  }

  putAudio(wawuUserId: string, name: string, audio: Buffer): Promise<string> {
    return this.audio.put(wawuUserId, name, audio, 'audio/mpeg');
  }

  urlFor(key: string): Promise<string> {
    return this.audio.urlFor(key);
  }

  /** A recording the person replaced is removed through storage; Hub-made audio through the audio store. */
  remove(key: string): Promise<void> {
    return key.startsWith(`${RECORDING_FOLDER}/`)
      ? this.storage.removeGenerated(key)
      : this.audio.remove(key);
  }
}
