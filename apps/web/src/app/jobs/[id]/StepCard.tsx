/**
 * One finished step in "Who did what" on the job page.
 *
 * Shows the agent, what they did, and the detail (which carries the
 * verdict — PASS, FIX, "Revised once"). It deliberately does NOT show
 * the step's model name, token count or cost: the customer asked for
 * that line to be hidden. The data is still in the report and still
 * recorded in the money log for the CFO audit — only the display is
 * gone.
 */
export interface JobStepCard {
  agent: string;
  what: string;
  detail?: string;
  /** Kept in the type because the report carries them — never rendered. */
  model?: string;
  tokens?: number;
  costUsd?: number;
}

export default function StepCard({ step }: { step: JobStepCard }) {
  return (
    <div className="card pad" style={{ marginTop: 12 }}>
      <p>
        <b>{step.agent}</b> — {step.what}
      </p>
      {step.detail && (
        <p style={{ marginTop: 4, color: "var(--ink-2)", fontSize: 14, lineHeight: 1.6 }}>{step.detail}</p>
      )}
    </div>
  );
}
