/**
 * Settings of the community message notice sweep (FIX-105, R-81). Defaults
 * (agent), owner may override; each can be changed in the environment with no
 * code change.
 *
 *  - SETTLE: a message is counted once it is this old, so a message whose
 *    transaction was slow to commit is never missed by a window that closed
 *    just before it appeared. It is also the debounce: a burst of messages
 *    inside it is one batch of writes, not one write per message.
 *  - SWEEP: how often a Hub instance looks for finished windows.
 *  - MAX_WINDOW: the longest stretch of time one pass folds in, so a Hub that
 *    was stopped for a day catches up in steps instead of one huge read.
 */
function seconds(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : fallback;
}

export const COMMUNITY_NOTICE_SETTLE_SECONDS = seconds(
  'COMMUNITY_NOTICE_SETTLE_SECONDS',
  5,
);
export const COMMUNITY_NOTICE_SWEEP_SECONDS = seconds(
  'COMMUNITY_NOTICE_SWEEP_SECONDS',
  5,
);
export const COMMUNITY_NOTICE_MAX_WINDOW_SECONDS = seconds(
  'COMMUNITY_NOTICE_MAX_WINDOW_SECONDS',
  600,
);
/** How long one instance holds the sweep before another may take it over. */
export const COMMUNITY_NOTICE_LEASE_SECONDS = 120;
