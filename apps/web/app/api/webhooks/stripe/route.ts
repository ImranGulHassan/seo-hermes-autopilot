import { NextResponse } from "next/server";
import { createPool, migrate, PostgresBillingStore, type BillingPlan } from "@seo-autopilot/database";
import { billingStatus, paidPlans, planForPrice, stripeClient } from "../../../../lib/billing/stripe";

export const dynamic = "force-dynamic";
function isoEpoch(value: unknown): string | null { return typeof value === "number" ? new Date(value * 1000).toISOString() : null; }

export async function POST(request: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET, signature = request.headers.get("stripe-signature");
  if (!secret || !signature) return NextResponse.json({ error: "Stripe webhook is not configured." }, { status: 503 });
  let event;
  try { event = stripeClient().webhooks.constructEvent(await request.text(), signature, secret); }
  catch { return NextResponse.json({ error: "Invalid Stripe signature." }, { status: 400 }); }
  if (!process.env.DATABASE_URL) return NextResponse.json({ error: "Billing storage is not configured." }, { status: 503 });
  const pool = createPool({ connectionString: process.env.DATABASE_URL, max: 2 });
  try {
    await migrate(pool);
    const stripe = stripeClient(), store = new PostgresBillingStore(pool), object: any = event.data.object;
    let subscription: any = null, organizationId: string | undefined, plan: BillingPlan | null = null;
    if (event.type === "checkout.session.completed") {
      organizationId = object.metadata?.organizationId ?? object.client_reference_id;
      plan = object.metadata?.plan ?? null;
      if (typeof object.subscription === "string") subscription = await stripe.subscriptions.retrieve(object.subscription);
    } else if (event.type.startsWith("customer.subscription.")) {
      subscription = object; organizationId = subscription.metadata?.organizationId;
      plan = subscription.metadata?.plan ?? planForPrice(subscription.items?.data?.[0]?.price?.id);
    } else if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
      const subscriptionId = typeof object.subscription === "string" ? object.subscription : object.parent?.subscription_details?.subscription;
      if (typeof subscriptionId === "string") {
        subscription = await stripe.subscriptions.retrieve(subscriptionId); organizationId = subscription.metadata?.organizationId;
        plan = subscription.metadata?.plan ?? planForPrice(subscription.items?.data?.[0]?.price?.id);
      }
    }
    if (!organizationId || !plan || plan === "design-partner" || !paidPlans.includes(plan as typeof paidPlans[number]) || !subscription) return NextResponse.json({ received: true, ignored: true });
    const firstItem = subscription.items?.data?.[0], status = event.type === "invoice.payment_failed" ? "past_due" : billingStatus(subscription.status);
    const processed = await store.reconcile({ eventId: event.id, eventType: event.type, organizationId, plan, status, customerId: typeof subscription.customer === "string" ? subscription.customer : null, subscriptionId: subscription.id, priceId: firstItem?.price?.id ?? null, currentPeriodStart: isoEpoch(subscription.current_period_start ?? firstItem?.current_period_start), currentPeriodEnd: isoEpoch(subscription.current_period_end ?? firstItem?.current_period_end), cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end) });
    return NextResponse.json({ received: true, processed });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Stripe webhook failed." }, { status: 500 }); }
  finally { await pool.end(); }
}
