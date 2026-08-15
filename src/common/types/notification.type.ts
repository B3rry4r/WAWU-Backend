import type { NotificationModel } from '../../../generated/prisma/models';
import type { PaginatedListResponse } from './shared.type';

export type Notification = NotificationModel;

/** GET /notifications response.shape: "{unreadCount, items: PaginatedList<Notification>}". */
export interface NotificationsResponse {
  unreadCount: number;
  items: PaginatedListResponse<Notification>;
}
