"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

export type ConnectorState = "not_connected" | "pending" | "healthy" | "error" | "skipped";
export interface OnboardingStatus {
  organization?: { id: string; name: string; slug: string } | null;
  site?: { id: string; name: string; url: string } | null;
  github?: { state: ConnectorState; repository?: string; installUrl?: string; message?: string } | null;
  gsc?: { state: ConnectorState; property?: string; message?: string } | null;
  posthog?: { state: ConnectorState; host?: string; message?: string } | null;
  configuration?: { branch: string; protectedPaths: string[] } | null;
  scan?: { state: "idle" | "queued" | "running" | "complete" | "error"; pages?: number; opportunities?: number; message?: string } | null;
}

export const ONBOARDING_STEPS = ["Workspace", "GitHub", "Search Console", "Conversions", "Safety", "First scan", "Health"] as const;

export function completedSteps(status: OnboardingStatus): boolean[] {
  return [
    Boolean(status.organization && status.site),
    status.github?.state === "healthy",
    status.gsc?.state === "healthy",
    status.posthog?.state === "healthy" || status.posthog?.state === "skipped",
    Boolean(status.configuration?.branch),
    status.scan?.state === "complete",
    false,
  ];
}

export function nextIncompleteStep(status: OnboardingStatus): number {
  const completed = completedSteps(status);
  const index = completed.findIndex((value, step) => step < completed.length - 1 && !value);
  return index < 0 ? completed.length - 1 : index;
}

async function request(path: string, body?: unknown): Promise<OnboardingStatus> {
  const response = await fetch(`/api/v1/onboarding${path}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as OnboardingStatus & {
    error?: string; action?: string; sites?: Array<{id:string;name?:string;url:string}>;
    github?: OnboardingStatus["github"] & {status?:string;error?:string;branch?:string};
    gsc?: OnboardingStatus["gsc"] & {status?:string;error?:string};
    posthog?: OnboardingStatus["posthog"] & {status?:string;error?:string;projectId?:string};
    scan?: OnboardingStatus["scan"] & {error?:string;runId?:string};
  };
  if (!response.ok) throw new Error([payload.error || `Request failed (${response.status})`, payload.action].filter(Boolean).join(" "));
  const connectorState = (value?: string): ConnectorState => value === "connected" ? "healthy" : value === "disconnected" ? "not_connected" : value === "failed" ? "error" : (value as ConnectorState) || "not_connected";
  return {
    ...payload,
    site: payload.site ?? (payload.sites?.[0] ? {...payload.sites[0],name:payload.sites[0].name ?? payload.sites[0].url} : null),
    github: payload.github ? {...payload.github,state:connectorState(payload.github.state ?? payload.github.status),message:payload.github.message ?? payload.github.error} : null,
    gsc: payload.gsc ? {...payload.gsc,state:connectorState(payload.gsc.state ?? payload.gsc.status),message:payload.gsc.message ?? payload.gsc.error} : null,
    posthog: payload.posthog ? {...payload.posthog,state:connectorState(payload.posthog.state ?? payload.posthog.status),message:payload.posthog.message ?? payload.posthog.error} : null,
    scan: payload.scan ? {...payload.scan,state:(String(payload.scan.state) === "not-started" ? "idle" : String(payload.scan.state) === "failed" ? "error" : payload.scan.state),message:payload.scan.message ?? payload.scan.error} : null,
  };
}

function StateBadge({ state }: { state?: string }) {
  return <span className={`onboarding-state state-${state ?? "not_connected"}`}>{(state ?? "not connected").replaceAll("_", " ")}</span>;
}

export function OnboardingWizard({ ownerName, organizationName, initialError }: { ownerName: string; organizationName: string; initialError?: string }) {
  const [status, setStatus] = useState<OnboardingStatus>({});
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError ?? null);
  const completed = useMemo(() => completedSteps(status), [status]);

  const refresh = useCallback(async () => {
    try {
      const fresh = await request("");
      setStatus(fresh);
      setStep(nextIncompleteStep(fresh));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not load onboarding status."); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  async function submit(path: string, body: unknown) {
    setBusy(true); setError(null);
    try { const fresh = await request(path, body); setStatus(fresh); setStep(nextIncompleteStep(fresh)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "This step could not be saved."); }
    finally { setBusy(false); }
  }

  async function submitWorkspace(value: Record<string,string>) {
    setBusy(true); setError(null);
    try {
      await request("/organization", {name:value.organizationName,slug:value.slug});
      const fresh = await request("/site", {name:value.siteName,url:value.url});
      setStatus(fresh); setStep(nextIncompleteStep(fresh));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The workspace could not be created."); }
    finally { setBusy(false); }
  }

  return <main className="onboarding-page">
    <header className="onboarding-header">
      <div><p className="eyebrow">Guided setup</p><h1>Connect your SEO workspace</h1><p>{organizationName} · Owner: {ownerName}</p></div>
      <a href="/">Exit to dashboard</a>
    </header>
    <div className="onboarding-layout">
      <aside className="onboarding-steps" aria-label="Onboarding progress">
        <div className="onboarding-progress"><span style={{ width: `${Math.round((completed.filter(Boolean).length / 6) * 100)}%` }} /></div>
        {ONBOARDING_STEPS.map((label, index) => <button key={label} className={step === index ? "active" : ""} onClick={() => setStep(index)}>
          <i>{completed[index] ? "✓" : index + 1}</i><span>{label}<small>{completed[index] ? "Complete" : index === step ? "In progress" : "Not complete"}</small></span>
        </button>)}
      </aside>
      <section className="onboarding-card">
        {error && <div className="onboarding-error" role="alert"><strong>Setup needs attention</strong><span>{error}</span><button onClick={() => void refresh()}>Retry status check</button></div>}
        {step === 0 && <SimpleForm title="Create your workspace" intro="Name the organization and first site your team will monitor." submit="Save workspace" busy={busy} fields={[['organizationName','Organization name',status.organization?.name ?? organizationName],['slug','Organization slug',status.organization?.slug ?? ''],['siteName','Site name',status.site?.name ?? ''],['url','Production URL',status.site?.url ?? 'https://']]} onSubmit={submitWorkspace} />}
        {step === 1 && <SimpleForm title="Connect GitHub" intro="Choose the repository where SEO Autopilot may inspect source and prepare reviewable pull requests." submit="Connect and verify repository" busy={busy} fields={[['repository','Repository (owner/name)',status.github?.repository ?? ''],['installationId','Installation ID (optional)','']]} optional={['installationId']} onSubmit={(v) => submit("/github", v)}><StateBadge state={status.github?.state}/>{status.github?.message && <p className="onboarding-hint">{status.github.message}</p>}{status.github?.installUrl&&<a className="onboarding-secondary" href={status.github.installUrl} target="_blank" rel="noreferrer">Install or configure the GitHub App ↗</a>}<p className="onboarding-note">Install the App for the selected repository, then enter its installation ID if it differs from the default installation.</p></SimpleForm>}
        {step === 2 && <div><StepHeading title="Connect Google Search Console" intro="Authorize read-only access to search performance and indexed-page data."/><StateBadge state={status.gsc?.state}/>{status.gsc?.property && <p className="onboarding-hint">Property: {status.gsc.property}</p>}<a className="onboarding-primary" href="/api/v1/onboarding/google/start">Connect Google Search Console</a><p className="onboarding-note">You will return here after Google authorization. SEO Autopilot requests only the access needed to read your Search Console data.</p></div>}
        {step === 3 && <SimpleForm title="Configure conversions (optional)" intro="Use PostHog landing-page conversions to prioritize fixes by business value." submit="Verify PostHog" busy={busy} fields={[['host','PostHog host',status.posthog?.host ?? 'https://us.posthog.com'],['projectId','Project ID',''],['apiKey','Personal API key','']]} secret="apiKey" onSubmit={(v) => submit("/posthog", v)}><StateBadge state={status.posthog?.state}/><button className="onboarding-secondary" disabled={busy} onClick={() => void submit("/posthog", { skip: true })}>Skip conversions</button></SimpleForm>}
        {step === 4 && <ConfigurationForm status={status} busy={busy} onSubmit={(value) => submit("/configuration", value)} />}
        {step === 5 && <div><StepHeading title="Run the first read-only scan" intro="Crawl the site, inspect repository metadata, and collect evidence. This scan cannot modify code or open a pull request."/><StateBadge state={status.scan?.state}/>{status.scan?.message && <p className="onboarding-hint">{status.scan.message}</p>}<button className="onboarding-primary" disabled={busy || status.scan?.state === "running" || status.scan?.state === "queued"} onClick={() => void submit("/scan", {})}>{busy ? "Starting…" : "Run read-only scan"}</button></div>}
        {step === 6 && <Health status={status} onRefresh={refresh} />}
      </section>
    </div>
  </main>;
}

function StepHeading({ title, intro }: { title: string; intro: string }) { return <><p className="eyebrow">Onboarding</p><h2>{title}</h2><p className="onboarding-intro">{intro}</p></>; }

function SimpleForm({ title, intro, submit: label, busy, fields, secret, optional = [], onSubmit, children }: { title:string; intro:string; submit:string; busy:boolean; fields:string[][]; secret?:string; optional?:string[]; onSubmit:(value:Record<string,string>)=>void; children?:React.ReactNode }) {
  function handle(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const data = new FormData(event.currentTarget); onSubmit(Object.fromEntries(data.entries()) as Record<string,string>); }
  return <form className="onboarding-form" onSubmit={handle}><StepHeading title={title} intro={intro}/>{children}<div className="onboarding-fields">{fields.map(([name,label,value]) => <label key={name}>{label}<input name={name} defaultValue={value} type={secret === name ? "password" : name === "url" ? "url" : "text"} required={!optional.includes(name) && name !== 'apiKey'} autoComplete="off"/></label>)}</div><button className="onboarding-primary" disabled={busy}>{busy ? "Saving…" : label}</button></form>;
}

function ConfigurationForm({ status, busy, onSubmit }: {status:OnboardingStatus; busy:boolean; onSubmit:(v:unknown)=>void}) {
  function handle(event:FormEvent<HTMLFormElement>) { event.preventDefault(); const data=new FormData(event.currentTarget); onSubmit({branch:data.get('branch'),protectedPaths:String(data.get('protectedPaths')??'').split('\n').map(v=>v.trim()).filter(Boolean)}); }
  return <form className="onboarding-form" onSubmit={handle}><StepHeading title="Set repository safety rules" intro="Choose the deployment branch and paths that the agent must never change without explicit approval."/><label>Default branch<input name="branch" defaultValue={status.configuration?.branch ?? "main"} required/></label><label>Protected paths (one per line)<textarea name="protectedPaths" rows={7} defaultValue={(status.configuration?.protectedPaths ?? ["app/api/**","middleware.ts","next.config.*"]).join('\n')}/></label><button className="onboarding-primary" disabled={busy}>{busy?'Saving…':'Save safety rules'}</button></form>;
}

function Health({status,onRefresh}:{status:OnboardingStatus;onRefresh:()=>Promise<void>}) { const items=[['GitHub',status.github],['Search Console',status.gsc],['PostHog',status.posthog],['First scan',status.scan]] as const; return <div><StepHeading title="Connector health" intro="Everything needed for safe, evidence-backed recommendations is shown here."/><div className="onboarding-health">{items.map(([name,item])=><div key={name}><span><strong>{name}</strong><small>{item?.message ?? (item?.state==='healthy'||item?.state==='complete'?'Verified and ready':'Complete this connection to continue.')}</small></span><StateBadge state={item?.state}/></div>)}</div>{status.scan?.state==='complete'&&<div className="onboarding-success"><strong>Workspace is ready</strong><span>{status.scan.pages ?? 0} pages checked · {status.scan.opportunities ?? 0} opportunities found</span><a href="/">Open dashboard</a></div>}<button className="onboarding-secondary" onClick={()=>void onRefresh()}>Refresh health</button></div>; }
