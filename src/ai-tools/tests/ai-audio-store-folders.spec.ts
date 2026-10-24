import {
  AI_AUDIO_FOLDER,
  AI_AUDIO_FOLDERS,
  AI_MUSIC_FOLDER,
  AI_SFX_FOLDER,
  audioKeyFor,
  StorageAiAudioStore,
} from '../audio/ai-audio-store';
import { GENERATED_KEY_FOLDERS } from '../../storage/storage.service';
import { FILE_KINDS } from '../../account-purge/purge-files';
import { AI_TOOLS } from '../tools';
import type { StorageService } from '../../storage/storage.service';

/**
 * AITOOLS-03: the audio of each tool is the person's own, in the tool's own
 * folder, so their account deletion removes it (the purge decides every
 * folder, and a spec holds the table to this list).
 */
describe('AITOOLS-03: where the AI tools keep their audio', () => {
  it("stores through putGenerated, recorded as the person, in the folder the tool names (VoiceOver's when none is named)", async () => {
    const calls: unknown[][] = [];
    const storage = {
      putGenerated: (...a: unknown[]) => {
        calls.push(a);
        return Promise.resolve(
          `${String(a[1])}/${String(a[0])}/${String(a[2])}.mp3`,
        );
      },
    } as unknown as StorageService;
    const store = new StorageAiAudioStore(storage);
    const audio = Buffer.from('x');
    expect(await store.put('u1', 'j1', audio, 'audio/mpeg')).toBe(
      'ai/voiceover/u1/j1.mp3',
    );
    expect(
      await store.put('u1', 'j2', audio, 'audio/mpeg', AI_SFX_FOLDER),
    ).toBe('ai/sound-effect/u1/j2.mp3');
    expect(
      await store.put('u1', 'j3', audio, 'audio/mpeg', AI_MUSIC_FOLDER),
    ).toBe('ai/music/u1/j3.mp3');
    expect(calls.map((c) => [c[0], c[1]])).toEqual([
      ['u1', 'ai/voiceover'],
      ['u1', 'ai/sound-effect'],
      ['u1', 'ai/music'],
    ]);
  });

  it('every folder a tool writes to is a folder the Hub writes, has a purge decision, and the key a job is found by matches it', () => {
    for (const tool of AI_TOOLS) {
      // Captions makes words, not audio: no folder to check.
      if (tool.audioFolder === null) continue;
      expect(AI_AUDIO_FOLDERS).toContain(tool.audioFolder);
      expect([...GENERATED_KEY_FOLDERS]).toContain(tool.audioFolder);
      expect(FILE_KINDS[tool.audioFolder]?.decision).toBe('DELETE');
      expect(audioKeyFor('u', 'j', tool.audioFolder)).toBe(
        `${tool.audioFolder}/u/j.mp3`,
      );
    }
    expect(audioKeyFor('u', 'j')).toBe(`${AI_AUDIO_FOLDER}/u/j.mp3`);
    expect(AI_TOOLS.map((t) => t.audioFolder)).toEqual([
      'ai/voiceover',
      'ai/voiceover',
      'ai/sound-effect',
      'ai/music',
      null,
      'ai/clean-audio',
      // AITOOLS-05: Dubbing's lossless audio. This list pinned the registry's six tools; it names the seventh.
      'ai/dubbing',
    ]);
  });
});
