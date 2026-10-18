import {
  GENERATED_KEY_FOLDERS,
  KEY_FOLDERS,
  objectKeyFrom,
} from '../storage.service';
import { UPLOAD_FOLDERS } from '../dto/presign-upload.dto';
import { CHAT_UPLOAD_FOLDERS } from '../../chat/chat-limits';
import { AI_AUDIO_FOLDER } from '../../ai-tools/audio/ai-audio-store';

/**
 * FIX-71. `objectKeyFrom` recovers the key from a stored link by matching it
 * against the folders this server writes to. It matched only the public
 * upload folders, so a link into a chat folder or the Hub's own AI audio
 * folder was never recognised and so never signed again or found for a purge.
 */
const HOST = 'https://fix71-bucket.test.invalid';

describe('objectKeyFrom folders (FIX-71)', () => {
  it('knows every folder a key can start with', () => {
    for (const folder of [
      ...UPLOAD_FOLDERS,
      ...CHAT_UPLOAD_FOLDERS,
      AI_AUDIO_FOLDER,
    ]) {
      expect(KEY_FOLDERS).toContain(folder);
      const key = `${folder}/user-1/x.bin`;
      expect(objectKeyFrom(`${HOST}/${key}?X-Amz-Signature=old`)).toBe(key);
      expect(objectKeyFrom(`https://s.test.invalid/b/${key}?sig=1`)).toBe(key);
    }
  });

  it('keeps the Hub-written folder list equal to the AI audio folder', () => {
    expect([...GENERATED_KEY_FOLDERS]).toEqual([AI_AUDIO_FOLDER]);
  });

  it('recovers a chat photo, a chat file and an AI voice-over link', () => {
    expect(objectKeyFrom(`${HOST}/chat/media/u-1/a.jpg?sig=1`)).toBe(
      'chat/media/u-1/a.jpg',
    );
    expect(objectKeyFrom(`${HOST}/chat/file/u-1/a.pdf?sig=1`)).toBe(
      'chat/file/u-1/a.pdf',
    );
    expect(objectKeyFrom(`${HOST}/ai/voiceover/u-1/job-1.mp3?sig=1`)).toBe(
      'ai/voiceover/u-1/job-1.mp3',
    );
  });

  it('answers as it did for every folder it knew before', () => {
    for (const folder of UPLOAD_FOLDERS) {
      const key = `${folder}/user-1/x.png`;
      expect(objectKeyFrom(`${HOST}/${key}?sig=1`)).toBe(key);
      expect(objectKeyFrom(key)).toBe(key);
    }
    const external = 'https://cdn.example.com/some/other/image.png';
    expect(objectKeyFrom(external)).toBe(external);
    const near = `${HOST}/chat/other/u-1/a.jpg`;
    expect(objectKeyFrom(near)).toBe(near);
  });
});
