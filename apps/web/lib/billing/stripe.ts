import Stripe from "stripe";
import type { BillingPlan, BillingStatus } from "@seo-autopilot/database";

export const paidPlans = ["starter", "growth", "team"] as const;
export type PaidPlan = typeof paidPlans[number];
export function stripeClient(): Stripe { const key=process.env.STRIPE_SECRET_KEY;if(!key)throw new Error("Stripe billing is not configured.");return new Stripe(key); }
export function priceForPlan(plan: PaidPlan): string { const key=`STRIPE_PRICE_${plan.toUpperCase()}`;const price=process.env[key];if(!price)throw new Error(`${key} is not configured.`);return price; }
export function planForPrice(priceId: string | null | undefined): BillingPlan | null { if(!priceId)return null;for(const plan of paidPlans)if(process.env[`STRIPE_PRICE_${plan.toUpperCase()}`]===priceId)return plan;return null; }
export function billingStatus(value: string): BillingStatus { return ["trialing","active","past_due","canceled","unpaid","incomplete","paused"].includes(value)?value as BillingStatus:"incomplete"; }
export function configured(): boolean { return Boolean(process.env.STRIPE_SECRET_KEY&&process.env.STRIPE_WEBHOOK_SECRET&&paidPlans.every(plan=>process.env[`STRIPE_PRICE_${plan.toUpperCase()}`])); }
