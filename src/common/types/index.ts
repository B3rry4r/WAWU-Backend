/**
 * Shared types barrel — the single source of truth for every registry
 * resource's wire shape. Phase 5 build agents import from here instead of
 * re-declaring shapes (task brief). One file per registry.json resource
 * (39 resources total; 4 have no Prisma model — see prisma/schema.prisma
 * header comment and each file's own doc comment for why).
 */
export * from './shared.type';
export * from './user-profile.type';
export * from './creator-state.type';
export * from './verification-submission.type';
export * from './kyc-submission.type';
export * from './content-piece.type';
export * from './course-lesson.type';
export * from './comment.type';
export * from './purchase.type';
export * from './saved-item.type';
export * from './follow-relationship.type';
export * from './direct-message.type';
export * from './creator-no-response-tracker.type';
export * from './dm-report.type';
export * from './community.type';
export * from './community-membership.type';
export * from './community-message.type';
export * from './credits-state.type';
export * from './credit-purchase.type';
export * from './credit-spend.type';
export * from './evg-score.type';
export * from './creator-earnings.type';
export * from './notification.type';
export * from './notification-settings.type';
export * from './search-response.type';
export * from './partner-service.type';
export * from './service-application.type';
export * from './mentor.type';
export * from './mentor-request.type';
export * from './learn-course.type';
export * from './course-enrollment.type';
export * from './learn-entitlement.type';
export * from './playbook.type';
export * from './learn-guide.type';
export * from './marketplace-save.type';
export * from './privacy-settings.type';
export * from './blocked-account.type';
export * from './data-export-request.type';
export * from './account.type';
export * from './shop.type';
