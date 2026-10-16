import { Test } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  LEGAL_DELIVERY_UPLOADER_IDS,
  LegalDeliveryConfigError,
  LegalDeliverySettings,
  readLegalDeliveryUploaderIds,
} from '../legal-delivery-settings';
import { LegalModule } from '../legal.module';

/**
 * FIX-24: LEGAL_DELIVERY_UPLOADER_IDS, the legal team's WAWU accounts. Empty
 * by default; a value that is set but unusable stops the server at boot,
 * naming the setting.
 */

const ID_1 = '0000f124-0000-4000-8000-000000000001';
const ID_2 = '0000f124-0000-4000-8000-0000000000ab';

describe('LEGAL_DELIVERY_UPLOADER_IDS', () => {
  it.each([
    ['unset', undefined],
    ['null', null],
    ['empty', ''],
    ['only spaces', '   '],
  ])('is an empty list when %s', (_l, raw) => {
    expect([...readLegalDeliveryUploaderIds(raw)]).toEqual([]);
  });

  it('reads one id, several ids, spaces around commas, and any case', () => {
    expect([...readLegalDeliveryUploaderIds(ID_1)]).toEqual([ID_1]);
    expect([
      ...readLegalDeliveryUploaderIds(` ${ID_1} ,${ID_2.toUpperCase()} `),
    ]).toEqual([ID_1, ID_2]);
    expect([...readLegalDeliveryUploaderIds(`${ID_1},${ID_1}`)]).toEqual([
      ID_1,
    ]);
  });

  it.each([
    ['a word', 'legal-team'],
    ['a number', '12345'],
    ['an id with a trailing comma', `${ID_1},`],
    ['an empty entry', `${ID_1},,${ID_2}`],
    ['a leading comma', `,${ID_1}`],
    ['semicolons', `${ID_1};${ID_2}`],
    ['spaces between ids', `${ID_1} ${ID_2}`],
    ['an id that is one character short', ID_1.slice(1)],
    ['an id with a non-hex letter', ID_1.replace('f', 'g')],
    ['an id in braces', `{${ID_1}}`],
    ['an email', 'legal@example.com'],
    ['an id with a zero-width space', `${ID_1}\u200b`],
  ])('refuses %s, naming the setting', (_l, raw) => {
    expect(() => readLegalDeliveryUploaderIds(raw)).toThrow(
      LegalDeliveryConfigError,
    );
    expect(() => readLegalDeliveryUploaderIds(raw)).toThrow(
      LEGAL_DELIVERY_UPLOADER_IDS,
    );
  });

  it('never says more than the bad entry, and never uses an em-dash', () => {
    let message = '';
    try {
      readLegalDeliveryUploaderIds(`${ID_1},nope`);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toBe(
      'LEGAL_DELIVERY_UPLOADER_IDS must be WAWU ids separated by commas. "nope" is not a WAWU id.',
    );
    expect(message).not.toContain('—');
  });

  it('answers whether an account is listed, without case', () => {
    const settings = new LegalDeliverySettings({
      get: () => ID_2,
    } as unknown as ConfigService);
    expect(settings.isLegalTeam(ID_2)).toBe(true);
    expect(settings.isLegalTeam(ID_2.toUpperCase())).toBe(true);
    expect(settings.isLegalTeam(ID_1)).toBe(false);
  });

  describe('at boot', () => {
    const saved = process.env[LEGAL_DELIVERY_UPLOADER_IDS];
    afterEach(() => {
      if (saved === undefined) delete process.env[LEGAL_DELIVERY_UPLOADER_IDS];
      else process.env[LEGAL_DELIVERY_UPLOADER_IDS] = saved;
    });

    const boot = () =>
      Test.createTestingModule({
        imports: [ConfigModule.forRoot({ isGlobal: true }), LegalModule],
      }).compile();

    it('stops the legal module, naming the setting, when it is malformed', async () => {
      process.env[LEGAL_DELIVERY_UPLOADER_IDS] = `${ID_1},not-an-id`;
      await expect(boot()).rejects.toThrow(LEGAL_DELIVERY_UPLOADER_IDS);
    });

    it('starts with the setting empty, and with a list of ids', async () => {
      process.env[LEGAL_DELIVERY_UPLOADER_IDS] = '';
      const empty = await boot();
      expect(empty.get(LegalDeliverySettings).uploaderIds.size).toBe(0);
      await empty.close();
      process.env[LEGAL_DELIVERY_UPLOADER_IDS] = `${ID_1}, ${ID_2}`;
      const listed = await boot();
      expect([...listed.get(LegalDeliverySettings).uploaderIds]).toEqual([
        ID_1,
        ID_2,
      ]);
      await listed.close();
    });
  });
});
