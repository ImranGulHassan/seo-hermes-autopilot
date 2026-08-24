import { requireRole } from "../../lib/auth/session";
import { OnboardingWizard } from "../components/onboarding-wizard";

export default async function OnboardingPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const session = await requireRole("owner", "/onboarding");
  const query = await searchParams;
  return <OnboardingWizard ownerName={session.name ?? session.email} organizationName={session.organizationName} initialError={query.error} />;
}
