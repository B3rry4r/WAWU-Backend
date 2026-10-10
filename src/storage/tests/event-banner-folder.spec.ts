import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  FOLDER_CONTENT_TYPES,
  PresignUploadDto,
  UPLOAD_FOLDERS,
} from '../dto/presign-upload.dto';

/**
 * EVENTS-04: the host wizard's banner (E14) uploads to its own folder,
 * `event/banner`, which takes pictures only.
 */
describe('POST /uploads/presign folder event/banner (EVENTS-04)', () => {
  const dto = (folder: string, contentType: string) =>
    plainToInstance(PresignUploadDto, {
      folder,
      contentType,
      extension: 'jpg',
      contentLength: 1000,
    });

  it('is a folder a client may name', () => {
    expect(UPLOAD_FOLDERS).toContain('event/banner');
    expect(
      validateSync(dto('event/banner', 'image/jpeg')).map((e) => e.property),
    ).not.toContain('folder');
  });

  it('holds pictures only', () => {
    expect([...FOLDER_CONTENT_TYPES['event/banner']].sort()).toEqual(
      ['image/jpeg', 'image/png', 'image/webp'].sort(),
    );
  });

  it('a folder nobody declared is still refused', () => {
    expect(
      validateSync(dto('event/poster', 'image/jpeg')).map((e) => e.property),
    ).toContain('folder');
  });
});
