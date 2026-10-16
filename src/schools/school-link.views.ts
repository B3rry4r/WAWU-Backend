/**
 * SC9's link (SCHOOLS-10). `url` is the school's own page with the school's
 * code added (`https://greenfield.ng/apply?ref=wawu-7KQ2`): the phone's own
 * browser opens it. `code` is the part after `ref=`. Nothing about the person
 * is in either.
 */
export interface SchoolApplyLinkView {
  courseId: string;
  code: string;
  url: string;
}
