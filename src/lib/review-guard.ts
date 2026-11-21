/** A review never authorizes overwriting a different draft or disk revision. */
export type ReviewDecision = 'accept' | 'different-file' | 'draft-changed' | 'disk-changed';

export interface ReviewIdentity {
  path: string;
  reviewedDraft: string;
  reviewedDiskRevision: string;
}

export function reviewDecision(
  review: ReviewIdentity,
  currentPath: string,
  currentDraft: string,
  currentDiskRevision: string,
): ReviewDecision {
  if (review.path !== currentPath) return 'different-file';
  if (review.reviewedDraft !== currentDraft) return 'draft-changed';
  if (review.reviewedDiskRevision !== currentDiskRevision) return 'disk-changed';
  return 'accept';
}
