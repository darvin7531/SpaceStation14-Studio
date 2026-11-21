import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewDecision } from '../src/lib/review-guard';

const reviewed = {
  path: 'Resources/Prototypes/entities.yml',
  reviewedDraft: '- type: entity\n  id: Local\n',
  reviewedDiskRevision: 'a'.repeat(64),
};

test('an exact reviewed draft and disk revision may be accepted explicitly', () => {
  assert.equal(reviewDecision(reviewed, reviewed.path, reviewed.reviewedDraft, reviewed.reviewedDiskRevision), 'accept');
});

test('changing the edited text after displaying diff requires a new review', () => {
  assert.equal(reviewDecision(reviewed, reviewed.path, reviewed.reviewedDraft + '# extra', reviewed.reviewedDiskRevision), 'draft-changed');
});

test('an external disk change invalidates the review decision', () => {
  assert.equal(reviewDecision(reviewed, reviewed.path, reviewed.reviewedDraft, 'b'.repeat(64)), 'disk-changed');
});

test('a review is restricted to the exact resource path', () => {
  assert.equal(reviewDecision(reviewed, 'Resources/Prototypes/other.yml', reviewed.reviewedDraft, reviewed.reviewedDiskRevision), 'different-file');
});
