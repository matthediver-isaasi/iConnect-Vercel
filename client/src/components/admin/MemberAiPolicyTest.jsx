import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { askMemberAi, AnswerWithCitations, EscalationNotice, SourceDates } from "@/components/ai/MemberAiAssistant";

export default function MemberAiPolicyTest({ tenantId, enabled, hasUnsavedChanges, saving }) {
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState([]);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const controller = useRef(null);
  const scope = useRef(tenantId);
  // Reset immediately during a tenant render, before an old promise can update this tenant's result.
  if (scope.current !== tenantId) {
    scope.current = tenantId;
    controller.current?.abort();
  }
  useEffect(() => {
    setQuestion("");
    setTurns([]);
    setError("");
    setPending(false);
    return () => {
      controller.current?.abort();
      controller.current = null;
    };
  }, [tenantId]);

  const ask = async event => {
    event.preventDefault();
    const q = question.trim();
    if (q.length < 3 || q.length > 1000 || pending || !enabled || hasUnsavedChanges || saving) return;
    const request = new AbortController();
    controller.current = request;
    const requestedTenant = tenantId;
    setPending(true);
    setError("");
    try {
      // This is the same ask endpoint and session as the member assistant, not a
      // privileged impersonation or a separate retrieval/preview pipeline.
      const data = await askMemberAi({
        question: q,
        history: turns.map(turn => ({ role: turn.role, content: turn.content })),
        tenantId,
        signal: request.signal,
      });
      if (request.signal.aborted || scope.current !== requestedTenant) return;
      setTurns(previous => [...previous,
        { role: "user", content: q },
        { role: "assistant", content: data.answer, sources: Array.isArray(data.sources) ? data.sources : [], escalation: data.escalation },
      ]);
      setQuestion("");
    } catch (err) {
      if (!request.signal.aborted && scope.current === requestedTenant) setError(err.message || "Could not test the assistant.");
    } finally {
      if (controller.current === request) {
        controller.current = null;
        if (scope.current === requestedTenant) setPending(false);
      }
    }
  };

  return <section className="space-y-4 border-t border-slate-600 pt-6" aria-label="Test saved assistant settings" data-testid="member-ai-policy-test">
    <div>
      <h3 className="font-semibold text-slate-100">Test saved settings</h3>
      <p className="mt-1 text-sm text-slate-400">Saving makes changes live immediately. This test uses the normal assistant endpoint and your current session's access, not a member impersonation. Unsaved edits are not tested. What an admin sees does not prove what a member can see. Preferences guide responses but cannot guarantee wording.</p>
    </div>
    {!enabled && <p className="text-sm text-slate-300">Save the assistant as enabled before testing.</p>}
    {hasUnsavedChanges && <p className="text-sm text-amber-200" role="status">Save or discard unsaved changes to test the saved settings.</p>}
    {turns.length > 0 && <div className="max-h-96 space-y-3 overflow-auto rounded-lg border border-slate-600 bg-slate-900/50 p-4" data-testid="member-ai-test-results">
      {turns.map((turn, index) => <div key={index} className="text-sm text-slate-200">
        <p className="mb-1 font-semibold">{turn.role === "user" ? "Question" : "Answer"}</p>
        {turn.role === "user" ? <p className="whitespace-pre-wrap">{turn.content}</p> :
          <>
            <AnswerWithCitations content={turn.content} sources={turn.sources} className="text-slate-200" />
            <EscalationNotice escalation={turn.escalation} />
            {turn.sources?.filter(source => !source?._memberAiAnswerKind).length > 0 && <div className="mt-3">
              <p className="font-semibold">Sources</p>
              {turn.sources.filter(source => !source?._memberAiAnswerKind).map((source, i) => <div key={i} className="mt-1">
                {source.link ? <a href={source.link} className="underline" target="_blank" rel="noopener noreferrer">{source.citationId && `[${source.citationId}] `}{source.title}</a> :
                  <span>{source.citationId && `[${source.citationId}] `}{source.title}</span>}
                {source.typeLabel && <span className="ml-2 text-xs text-slate-400">{source.typeLabel}</span>}
                <SourceDates dates={source.dates} />
              </div>)}
            </div>}
          </>}
      </div>)}
    </div>}
    <form onSubmit={ask} className="space-y-2">
      <label htmlFor="ai-policy-test-question" className="text-sm text-slate-200">Question</label>
      <Textarea id="ai-policy-test-question" value={question} onChange={event => setQuestion(event.target.value)} maxLength={1000} rows={2} disabled={!enabled || pending || saving || hasUnsavedChanges} className="bg-slate-900/50 border-slate-600 text-white" data-testid="input-ai-policy-test-question" />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={!enabled || pending || saving || hasUnsavedChanges || question.trim().length < 3} data-testid="button-ai-policy-test">{pending ? "Testing..." : "Ask using saved settings"}</Button>
        {turns.length > 0 && <Button type="button" variant="outline" className="border-slate-600 text-slate-100" disabled={pending} onClick={() => { setTurns([]); setError(""); }}>Clear test history</Button>}
      </div>
    </form>
    {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
  </section>;
}