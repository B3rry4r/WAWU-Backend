/**
 * The 22 preview bodies the BILLS-01 round 2 verifier found still drew a green "found" (R2-1): a data object with a name
 * in it, where the name is a placeholder or a failure word, or only invisible characters, or the body flags a failure
 * beside the name. The real success body has never been seen (question 11), so each is a labelled guess. Round 3 reads
 * none of them as a meter found: the Hub answers `502 meter_unconfirmed` for every one.
 */
export type NotGreenBody = [label: string, body: Record<string, unknown>];

const named = (Customer_Name: string): Record<string, unknown> => ({
  data: { Customer_Name },
  status: 200,
  message: 'Meter details fetched',
});

/** A placeholder or failure word where a person's name goes (verifier cases 55 to 65). */
export const PLACEHOLDER_NAMES = [
  'Meter not found',
  'Invalid meter number',
  'N/A',
  'null',
  'undefined',
  'Unknown',
  '-',
  'Customer not found',
  'ERROR',
  '0',
  'Not Available',
];

/** A name made only of characters nobody can see (cases 66 to 68): a zero-width space, a Braille blank, a Hangul filler. */
export const INVISIBLE_NAMES = ['\u200b', '\u2800', '\u3164'];

export const NOT_GREEN_BODIES: NotGreenBody[] = [
  ...PLACEHOLDER_NAMES.map((n): NotGreenBody => [
    `name text is "${n}"`,
    named(n),
  ]),
  ...INVISIBLE_NAMES.map((n, i): NotGreenBody => [
    `name only ${['a zero-width space', 'a Braille blank', 'a Hangul filler'][i]}`,
    { data: { name: n }, status: 200, message: 'Meter details fetched' },
  ]),
  [
    'success false beside a name',
    { success: false, message: 'failed', data: { name: 'X Y' } },
  ],
  ['error true beside a name', { error: true, data: { name: 'X Y' } }],
  [
    'statusCode 500 beside a name',
    {
      statusCode: 500,
      message: 'Internal server error',
      data: { name: 'X Y' },
    },
  ],
  [
    'status "failed" beside a name',
    { status: 'failed', data: { name: 'X Y' } },
  ],
  [
    'status "error" beside a name',
    { status: 'error', message: 'x', data: { name: 'X Y' } },
  ],
  [
    'data.status "failed" beside a name',
    { data: { name: 'X Y', status: 'failed' } },
  ],
  [
    'data.error beside a name',
    { data: { name: 'X Y', error: 'Meter not found' } },
  ],
  [
    'a top-level error text beside a name',
    { error: 'Meter not found', data: { name: 'X Y' } },
  ],
];
