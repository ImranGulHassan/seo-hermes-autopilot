import { redirect } from "next/navigation";
import { currentSession } from "../../lib/auth/session";

export const dynamic = "force-dynamic";

interface LoginPageProps {
  searchParams: Promise<{ token?: string; error?: string; returnTo?: string }>;
}

const errors: Record<string, string> = {
  expired: "That sign-in link is invalid, expired, or has already been used.",
  invalid: "Enter the complete sign-in token from your invitation.",
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  if (await currentSession()) redirect("/");
  const query = await searchParams;
  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="login-title">
        <div className="auth-mark" aria-hidden="true">↗</div>
        <p className="auth-eyebrow">SEO Autopilot</p>
        <h1 id="login-title">Sign in to your workspace</h1>
        <p className="auth-intro">Use the one-time link from your invitation. Links expire and can only be redeemed once.</p>
        {query.error ? <p className="auth-error" role="alert">{errors[query.error] ?? "Sign-in failed. Request a new invitation."}</p> : null}
        <form action="/auth/login" method="post" className="auth-form">
          <label htmlFor="token">One-time sign-in token</label>
          <input id="token" name="token" type="password" autoComplete="one-time-code" minLength={32} required defaultValue={query.token ?? ""} />
          <input type="hidden" name="returnTo" value={query.returnTo?.startsWith("/") && !query.returnTo.startsWith("//") ? query.returnTo : "/"} />
          <button type="submit">Continue securely</button>
        </form>
        <p className="auth-note">No password is stored. Ask your workspace owner for a new invitation if your link has expired.</p>
      </section>
    </main>
  );
}
