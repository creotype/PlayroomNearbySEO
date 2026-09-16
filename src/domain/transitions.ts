import type { ArticleStatus } from "./article.js";

const allowedTransitions: Record<ArticleStatus, ReadonlySet<ArticleStatus>> = {
  backlog: new Set(["brief_ready", "cancelled"]),
  brief_ready: new Set(["generating", "cancelled"]),
  generating: new Set(["qa_pending", "failed_generation", "cancelled"]),
  draft: new Set(["qa_pending", "needs_review", "cancelled"]),
  qa_pending: new Set(["needs_review", "failed_qa", "cancelled"]),
  needs_review: new Set(["approved", "revision_requested", "failed_qa", "cancelled"]),
  revision_requested: new Set(["qa_pending", "needs_review", "cancelled"]),
  approved: new Set(["scheduled", "publishing", "needs_review", "conflict", "cancelled"]),
  scheduled: new Set(["publishing", "needs_review", "conflict", "cancelled"]),
  publishing: new Set(["approved", "published", "failed_publish", "conflict"]),
  published: new Set(["needs_review"]),
  failed_generation: new Set(["brief_ready", "generating", "cancelled"]),
  failed_qa: new Set(["qa_pending", "revision_requested", "approved", "cancelled"]),
  failed_publish: new Set(["approved", "publishing", "cancelled"]),
  conflict: new Set(["needs_review", "cancelled"]),
  cancelled: new Set(["backlog"]),
};

export function canTransition(from: ArticleStatus, to: ArticleStatus): boolean {
  return allowedTransitions[from].has(to);
}

export function assertTransition(from: ArticleStatus, to: ArticleStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid article transition: ${from} -> ${to}`);
  }
}
