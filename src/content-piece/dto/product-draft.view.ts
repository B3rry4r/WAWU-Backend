/**
 * A product being drafted (TIER-02, VF2). Not a product: it holds no place
 * against the tier's product count until it is published.
 */
export interface ProductDraftView {
  id: string;
  title: string;
  contentType:
    'video' | 'course' | 'audio' | 'pdf' | 'image' | 'template' | null;
  description: string | null;
  category: string | null;
  specializations: string[];
  tags: string[];
  accessType: 'free' | 'paid' | null;
  /** Naira, whole, as POST /content takes it. Null until set. */
  price: number | null;
  /**
   * What publishing still needs, by field name: `contentType`,
   * `description`, `category`, `accessType` and, for a paid product, `price`.
   * Empty when the draft is ready for its files. VF2 draws "shop ready"
   * from it.
   */
  missing: string[];
  createdAt: string;
  updatedAt: string;
}
