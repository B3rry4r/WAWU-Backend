/**
 * A Nigerian mobile in the local `0...` form. Accepts `08031234567`,
 * `8031234567`, `2348031234567` and `+2348031234567`, with spaces, dashes
 * and brackets (docs/contract/CONVENTIONS.md section 2). Null when it is not
 * one. Provider-neutral: the BVN check's phone match uses it whichever
 * provider answered (MONEY-20); the Fintava client sends this form.
 */
export function toLocalNigerianPhone(phone: string): string | null {
  const d = phone.replace(/[\s\-()]/g, '');
  const m = /^(?:\+?234|0)?([789][01]\d{8})$/.exec(d);
  return m ? `0${m[1]}` : null;
}
