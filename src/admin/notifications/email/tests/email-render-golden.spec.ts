import { createHash } from 'node:crypto';
import { renderEmail } from '../email-render';

/**
 * EMAIL-03 pin: a Who Made This email with no button renders byte for byte as
 * it did before the Voices look was added. The hashes were taken from the
 * renderer as it stood on main (b51b4e37), before any change to it. Neither
 * input uses {{join_link}} or {{app_link}}.
 */
const h = (s: string) => createHash('sha256').update(s).digest('hex');

const FULL = {
  subject: 'Hi {{first_name}}, a note',
  previewText: 'Preview for {{first_name}}',
  body: 'Hello **{{first_name}}**,\n\nA [link](https://example.com/x?a=1&b=2) and *italic*.\n\n# Big\n\n## Small\n\n- one\n- two\n\n[Press me](https://example.com/go)\n\nLine one\nLine two <b>',
  firstName: 'Ada',
  unsubscribeUrl:
    'https://api.example.test/api/hub/email/unsubscribe?t=abc.def',
};
const PLAIN = {
  subject: 'Plain',
  body: 'Just text.',
  firstName: null,
  unsubscribeUrl: 'https://api.example.test/u?t=x.y',
};

describe('EMAIL-03 wmt render is unchanged', () => {
  it('full input, no brand given', () => {
    const m = renderEmail(FULL);
    expect([h(m.subject), h(m.html), h(m.text)]).toEqual([
      '7b216bb0db2bf331d5957ca5e9935b1b9948ea1f6be3d152b713ec648f39809d',
      '2f3aef788c51492c6055ba382d4e5ad9c4e09968a63db193090f84b44958fe65',
      '1bc7a1684663d5ab4934ffa67686bde6873377d5aff059866b3ad35341a3179c',
    ]);
  });

  it('plain input, no brand given', () => {
    const m = renderEmail(PLAIN);
    expect([h(m.subject), h(m.html), h(m.text)]).toEqual([
      '8b854ade2cd01bdca1aa982f6ecff0086f70e3d2140d7fae2786a2e4150eeb4c',
      'f6162561a9e2105ef92136c32285ccd160ce8bee3f970dcbcfb6339cfa26d268',
      'c4e6e2578aa46312dbc2163e9afc898c15e1311f2cdb66bb652f584022946ebf',
    ]);
  });

  it('brand wmt and a null button give the same bytes as no brand', () => {
    for (const input of [FULL, PLAIN]) {
      const a = renderEmail(input);
      const b = renderEmail({ ...input, brand: 'wmt', button: null });
      expect(b).toEqual(a);
    }
  });
});
