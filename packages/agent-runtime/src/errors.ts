export class ProposalValidationError extends Error {
  public constructor(public readonly issues: readonly string[]) {
    super(`Proposal is invalid: ${issues.join(' ')}`);
    this.name = 'ProposalValidationError';
  }
}

export class ProposalPromotionError extends Error {
  public constructor(public readonly status: ProposalStatus) {
    super(`A proposal with status ${status} cannot be promoted.`);
    this.name = 'ProposalPromotionError';
  }
}

export type ProposalStatus = 'pending' | 'cancelled' | 'error';
