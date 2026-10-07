/** One picture or video on a work, readable now. */
export interface ProfileWorkMediaView {
  /** A fresh signed link; never stored. */
  url: string | null;
  kind: 'image' | 'video';
}

/** One featured work as the API returns it (M33, M34, M35, M36). */
export interface ProfileWorkView {
  id: string;
  title: string;
  role: string;
  client: string | null;
  year: number;
  link: string | null;
  category: string | null;
  description: string | null;
  /** In the order the owner chose; the first is the cover. */
  media: ProfileWorkMediaView[];
  /** 0 is first. */
  position: number;
  createdAt: string;
}

/** One of M34's filter chips. */
export interface ProfileWorkCategoryView {
  name: string;
  count: number;
}

/**
 * A person's featured works. `count` is all of them (M34's "12"), `works` the
 * ones asked for (a category, a limit), and `categories` every category they
 * used with its count, for the chips.
 *
 * Deliberately not `{ items, total }`: that shape is read as a page by the
 * response envelope, which would drop `categories`.
 */
export interface ProfileWorksView {
  count: number;
  categories: ProfileWorkCategoryView[];
  works: ProfileWorkView[];
}

export interface ProfileEducationView {
  id: string;
  school: string;
  field: string | null;
  startYear: number;
  /** null means still studying there. */
  endYear: number | null;
  current: boolean;
}
