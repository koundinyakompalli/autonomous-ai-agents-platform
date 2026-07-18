import type { CSSProperties } from "react";
import "../watchdog/watchdog-landing.css";

const workflow = [
  {
    label: "Ask",
    title: "Describe the incident in plain language.",
    body: "Start with a Jira ticket or type what production support is seeing. Watchdog turns messy context into an investigation scope.",
  },
  {
    label: "Scope",
    title: "Customer, environment, service, and time window.",
    body: "The dashboard keeps humans in control: suggested filters are editable before the run touches CloudWatch.",
  },
  {
    label: "Analyze",
    title: "Evidence-backed findings from production logs.",
    body: "The agent searches client-mapped log groups, summarizes patterns, and cites the samples behind the conclusion.",
  },
  {
    label: "Escalate",
    title: "Hand off to DARCI when code context matters.",
    body: "When logs point at a defect, Watchdog packages findings into a DARCI task for root-cause analysis against the codebase.",
  },
];

const audiences = [
  ["Production support", "Triage without memorizing log groups, ARNs, regions, or CloudWatch query syntax."],
  ["Engineering", "Receive a concise incident dossier instead of a screenshot trail and scattered log snippets."],
  ["Product teams", "Understand customer impact quickly, with evidence and next-step ownership in one place."],
  ["Leadership", "See whether an issue is noise, configuration, infrastructure, or likely code-related."],
];

export function WatchdogLandingPage() {
  const openWatchdog = () => {
    window.history.pushState({}, "", "/watchdog");
    window.dispatchEvent(new PopStateEvent("popstate"));
  };

  return (
    <main className="wd-marketing">
      <section className="wdm-hero" aria-labelledby="watchdog-marketing-title">
        <div className="wdm-nav">
          <a className="wdm-brand" href="/watchdog/intro" aria-label="Watchdog home">
            <span className="wdm-brand-mark">W</span>
            <span>Watchdog</span>
          </a>
          <button className="wdm-nav-cta" type="button" onClick={openWatchdog}>
            Start investigation
          </button>
        </div>

        <div className="wdm-hero-grid">
          <div className="wdm-hero-copy">
            <p className="wdm-eyebrow">Level-0 production support</p>
            <h1 id="watchdog-marketing-title">Every log has a story. Ask Watchdog to read it.</h1>
            <p className="wdm-hero-text">
              Watchdog lets support teams investigate production logs with natural language, keep scope under human approval, and escalate evidence to DARCI when root-cause needs code analysis.
            </p>
            <div className="wdm-actions">
              <button className="wdm-primary" type="button" onClick={openWatchdog}>
                Open Watchdog
              </button>
              <a className="wdm-secondary" href="#workflow">
                See the flow
              </a>
            </div>
          </div>

          <div className="wdm-signal" aria-label="Watchdog analysis preview">
            <div className="wdm-signal-header">
              <span>natural language intake</span>
              <strong>ready</strong>
            </div>
            <div className="wdm-prompt">Check CIGNA PROD core auth errors from the last 3 hours</div>
            <div className="wdm-radar">
              <span />
              <span />
              <span />
            </div>
            <div className="wdm-finding">
              <span>finding</span>
              <strong>Auth failures clustered after deployment window</strong>
              <p>29 matching events, 2 affected streams, DARCI handoff available.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="wdm-strip" aria-label="Watchdog capabilities">
        <span>Jira or custom prompt</span>
        <span>CloudWatch evidence</span>
        <span>Human-approved scope</span>
        <span>DARCI root-cause handoff</span>
      </section>

      <section className="wdm-workflow" id="workflow">
        <div className="wdm-section-copy">
          <p className="wdm-eyebrow">From alert to answer</p>
          <h2>One guided path from symptom to evidence.</h2>
        </div>
        <div className="wdm-steps">
          {workflow.map((step, index) => (
            <article className="wdm-step" key={step.label} style={{ "--delay": `${index * 80}ms` } as CSSProperties}>
              <span>{step.label}</span>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="wdm-proof">
        <div className="wdm-proof-visual">
          <div className="wdm-log-line is-hot">ERROR AdminAuditLogService userId null</div>
          <div className="wdm-log-line">WARN retry policy exhausted for auth token lookup</div>
          <div className="wdm-log-line">INFO matched customer=CIGNA env=PROD1 service=core</div>
          <div className="wdm-log-line is-cool">DARCI task created with 1 finding and 1 evidence artifact</div>
        </div>
        <div className="wdm-proof-copy">
          <p className="wdm-eyebrow">Everyone can investigate</p>
          <h2>CloudWatch depth without CloudWatch ceremony.</h2>
          <p>
            Watchdog hides the brittle parts of log hunting: accounts, regions, ARNs, query templates, redaction, and evidence packaging. The operator stays focused on the production question.
          </p>
        </div>
      </section>

      <section className="wdm-audience" aria-label="Who Watchdog helps">
        {audiences.map(([title, body]) => (
          <div className="wdm-audience-row" key={title}>
            <h3>{title}</h3>
            <p>{body}</p>
          </div>
        ))}
      </section>

      <section className="wdm-final">
        <p className="wdm-eyebrow">Production support at its best</p>
        <h2>Start with a question. Leave with evidence.</h2>
        <button className="wdm-primary" type="button" onClick={openWatchdog}>
          Start a Watchdog task
        </button>
      </section>
    </main>
  );
}
