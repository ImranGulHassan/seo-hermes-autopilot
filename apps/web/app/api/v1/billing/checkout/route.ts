import { NextResponse } from "next/server";
import { z } from "zod";
import { createPool, migrate, PostgresBillingStore } from "@seo-autopilot/database";
import { isSameOrigin } from "../../../../../lib/auth/request";
import { currentSession, hasMinimumRole } from "../../../../../lib/auth/session";
import { paidPlans, priceForPlan, stripeClient } from "../../../../../lib/billing/stripe";

export async function POST(request:Request){
  if(!isSameOrigin(request))return NextResponse.json({error:"Invalid request origin."},{status:403});
  const session=await currentSession();if(!session)return NextResponse.json({error:"Unauthorized"},{status:401});
  if(!hasMinimumRole(session.role,"owner"))return NextResponse.json({error:"Owner access required."},{status:403});
  const parsed=z.object({plan:z.enum(paidPlans)}).safeParse(await request.json());
  if(!parsed.success)return NextResponse.json({error:"Invalid billing plan."},{status:400});
  if(!process.env.DATABASE_URL)return NextResponse.json({error:"Billing storage is not configured."},{status:503});
  const pool=createPool({connectionString:process.env.DATABASE_URL,max:2});
  try{
    await migrate(pool);const billing=await new PostgresBillingStore(pool).ensureDesignPartner(session.organizationId),stripe=stripeClient(),origin=new URL(request.url).origin;
    const checkout=await stripe.checkout.sessions.create({mode:"subscription",line_items:[{price:priceForPlan(parsed.data.plan),quantity:1}],success_url:`${origin}/billing?checkout=success`,cancel_url:`${origin}/billing?checkout=canceled`,client_reference_id:session.organizationId,customer:billing.stripeCustomerId??undefined,customer_email:billing.stripeCustomerId?undefined:session.email,allow_promotion_codes:true,metadata:{organizationId:session.organizationId,plan:parsed.data.plan},subscription_data:{metadata:{organizationId:session.organizationId,plan:parsed.data.plan}}});
    if(!checkout.url)throw new Error("Stripe did not return a checkout URL.");return NextResponse.json({url:checkout.url});
  }catch(error){return NextResponse.json({error:error instanceof Error?error.message:"Checkout could not be created."},{status:503})}finally{await pool.end()}
}
