import { proposalProgress } from "./proposalLifecycle";

const stateLabels = { current: "Current stage", complete: "Complete", upcoming: "Not reached", unconfirmed: "Not confirmed" };

export default function ProposalProgress({ status = "draft", singular = "Proposal" }) {
  const progress = proposalProgress(status);
  return <section aria-label={`${singular} progress`} className="rounded-lg border bg-slate-50/70 p-4">
    <div className="mb-4 flex flex-col gap-1">
      <h3 className="text-sm font-semibold text-slate-900">{singular} progress</h3>
      <p role="status" className="text-sm text-slate-600">{progress.message}</p>
    </div>
    <ol className="grid gap-3 md:grid-cols-5">
      {progress.steps.map((step, index) => <li key={step.id} aria-current={step.state === "current" ? "step" : undefined}
        className={`flex min-w-0 gap-3 border-l-2 pl-3 ${step.state === "current" ? "border-blue-600" : step.state === "complete" ? "border-emerald-600" : "border-slate-200"}`}>
        <span aria-hidden="true" className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${step.state === "current" ? "bg-blue-100 text-blue-800" : step.state === "complete" ? "bg-emerald-100 text-emerald-800" : "bg-slate-200 text-slate-600"}`}>{index + 1}</span>
        <div className="min-w-0"><p className="text-sm font-medium text-slate-900">{step.label}</p><p className="text-xs text-slate-500">{stateLabels[step.state]}</p></div>
      </li>)}
    </ol>
  </section>;
}
