/**
 * The word for the unit people earn, spend and convert to cash (task
 * POINTS-04). Whether points become "credits" is the owner's open question
 * (R-43, 5 Oct 2026); if it is ruled, this file is the only place the copy of
 * the points-to-cash routes and its history label change. (PT5's own labels,
 * POINTS-01, are in points-labels.ts.) A leaf file with no imports, so the
 * wallet's history labels can read it without reaching into the points code.
 */
export const POINTS_WORD = 'points';
export const POINTS_WORD_TITLE = 'Points';
