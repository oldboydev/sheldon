export class ProposalValidationError extends Error {
  public readonly code = 'PROPOSAL_INVALID';
  public readonly recovery =
    'Fix the proposed wiki files or reject this attempt and compile again.';

  public constructor(public readonly issues: readonly string[]) {
    super(`Proposal is invalid: ${issues.join(' ')}`);
    this.name = 'ProposalValidationError';
  }
}

export class ProposalPromotionError extends Error {
  public readonly code = 'PROPOSAL_NOT_PROMOTABLE';
  public readonly recovery = 'Choose a pending proposal that still has a stored document.';

  public constructor(public readonly status: ProposalStatus) {
    super(`A proposal with status ${status} cannot be promoted.`);
    this.name = 'ProposalPromotionError';
  }
}

export type ProposalStatus = 'pending' | 'cancelled' | 'error';
