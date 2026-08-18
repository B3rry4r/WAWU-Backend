import type { LegalService } from './legal-catalogue';

/**
 * The engagement letter a client signs before WAWU delivers legal work.
 *
 * The rendered text is stored on the request at signing time, not referenced
 * as a template id. A signature is only meaningful against the exact words
 * that were on screen, and templates change; keeping the text means a signed
 * contract still says in a year what it said on the day.
 */
export function renderContract(params: {
  service: LegalService;
  clientName: string;
  amountNaira: number;
  scopeNote?: string | null;
  requestId: string;
}): string {
  const naira = (n: number) => `NGN ${n.toLocaleString('en-NG')}`;
  return [
    'WAWU LEGAL, ENGAGEMENT LETTER',
    '',
    `Reference: ${params.requestId}`,
    `Client: ${params.clientName}`,
    `Service: ${params.service.name} (${params.service.category})`,
    '',
    '1. SCOPE OF WORK',
    params.scopeNote?.trim()
      ? params.scopeNote.trim()
      : `WAWU Legal will carry out ${params.service.name.toLowerCase()} as discussed in your consultation.`,
    '',
    '2. FEE',
    `The agreed fee for this work is ${naira(params.amountNaira)}, payable in full before work begins.`,
    'Consultation fees already paid are separate from this amount and are not refundable.',
    '',
    '3. WHAT IS NOT INCLUDED',
    'Government, filing, registry and third-party fees are not included unless stated in the scope above.',
    'Work outside the scope above requires a new quote and a new agreement.',
    '',
    '4. CLIENT RESPONSIBILITIES',
    'You confirm that the information and documents you have provided are true, complete and yours to provide.',
    'Delays caused by missing or incorrect information are not the responsibility of WAWU Legal.',
    '',
    '5. NO GUARANTEE OF OUTCOME',
    'WAWU Legal will act with reasonable professional skill and care. Where an outcome depends on a',
    'government agency, registry or court, WAWU Legal does not guarantee that outcome or its timing.',
    '',
    '6. LIMITATION OF LIABILITY',
    `WAWU Legal's total liability arising from this engagement is limited to the fee paid for it, being`,
    `${naira(params.amountNaira)}. WAWU Legal is not liable for indirect or consequential loss.`,
    '',
    '7. CONFIDENTIALITY',
    'Information you share for this engagement is treated as confidential and used only to deliver it.',
    '',
    '8. GOVERNING LAW',
    'This engagement is governed by the laws of the Federal Republic of Nigeria.',
    '',
    '9. ACCEPTANCE',
    'By typing your full name and submitting this form you agree to the terms above. This constitutes',
    'an electronic signature under the Nigerian Evidence Act.',
  ].join('\n');
}
