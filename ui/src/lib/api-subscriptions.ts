// (CE) Subscriptions/billing are a hosted-only feature. This is an all-allowed stub so
// the Community Edition UI compiles and runs with no plans, no quotas and no Stripe —
// every self-hosted user is on an unlimited "community" plan.

export interface SubscriptionPlan {
  id: string;
  name: string;
  [k: string]: unknown;
}
export interface UserSubscription {
  [k: string]: unknown;
}
export interface UsageStats {
  [k: string]: unknown;
}
export interface QuotaInfo {
  [k: string]: unknown;
}
export interface UserSubscriptionWithUsage {
  plan: SubscriptionPlan;
  usage: UsageStats;
  quota: QuotaInfo;
  [k: string]: unknown;
}

const COMMUNITY: UserSubscriptionWithUsage = {
  plan: { id: 'community', name: 'Community' },
  usage: {},
  quota: {},
};

export async function getSubscriptionPlans(): Promise<SubscriptionPlan[]> {
  return [{ id: 'community', name: 'Community' }];
}
export async function getMySubscription(): Promise<UserSubscriptionWithUsage> {
  return COMMUNITY;
}
export async function createCheckoutSession(..._args: unknown[]): Promise<{ url: string }> {
  throw new Error('Billing is available in the hosted edition only.');
}
export async function createPortalSession(): Promise<{ url: string }> {
  throw new Error('Billing is available in the hosted edition only.');
}
export async function startTrial(_planName: string): Promise<UserSubscriptionWithUsage> {
  return COMMUNITY;
}
export async function requestRefund(): Promise<{ success: boolean; message: string; refund_id?: string }> {
  return { success: false, message: 'Billing is available in the hosted edition only.' };
}
