import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { DEFAULT_RESPONSE_POLICY } from "@shared/memberAiResponsePolicy.js";

export { DEFAULT_RESPONSE_POLICY };

const LIMITS = {
  role: 1000, tone: 500, additionalInstructions: 3000, specialistTopics: 1000,
  escalationInstructions: 1000, escalationName: 120, escalationUrl: 2048, escalationEmail: 254,
};
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/;
const selectClass = "h-10 w-full rounded-md border border-slate-600 bg-slate-900/50 px-3 text-sm text-white";
const fieldClass = "bg-slate-900/50 border-slate-600 text-white placeholder:text-slate-500";
const outlineClass = "!border-slate-600 !bg-slate-800 !text-slate-100 hover:!bg-slate-700";

export function normalizePolicy(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    ...DEFAULT_RESPONSE_POLICY,
    ...Object.fromEntries(Object.keys(DEFAULT_RESPONSE_POLICY).filter(key => key !== "terminology" && source[key] !== undefined).map(key => [key, source[key]])),
    terminology: Array.isArray(source.terminology) ? source.terminology.map(item => ({ term: item?.term ?? "", preferred: item?.preferred ?? "" })) : [],
  };
}

export function policyValidationError(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return "Response policy must be an object.";
  for (const [key, max] of Object.entries(LIMITS)) {
    if (typeof policy[key] !== "string" || policy[key].length > max || CONTROL.test(policy[key])) {
      return `${key} must be plain text of at most ${max} characters.`;
    }
  }
  if (/[\r\n]/.test(policy.escalationName + policy.escalationUrl + policy.escalationEmail)) {
    return "Escalation contact details must be single-line text.";
  }
  if (!["concise", "balanced", "detailed"].includes(policy.answerLength)) return "Choose a valid answer length.";
  if (!["when_needed", "ask_first", "answer_directly"].includes(policy.clarification)) return "Choose a valid clarification preference.";
  if (typeof policy.multipleApproaches !== "boolean" || typeof policy.nextSteps !== "boolean") return "Choose valid response preferences.";
  if (!Array.isArray(policy.terminology) || policy.terminology.length > 30 ||
    policy.terminology.some(item => !item || typeof item.term !== "string" || typeof item.preferred !== "string" ||
      !item.term.trim() || !item.preferred.trim() || item.term.length > 100 || item.preferred.length > 100 ||
      CONTROL.test(item.term) || CONTROL.test(item.preferred))) {
    return "Enter up to 30 terminology pairs, each with a term and preferred wording of at most 100 plain-text characters.";
  }
  if (policy.escalationUrl) {
    try {
      const url = new URL(policy.escalationUrl);
      if (url.protocol !== "https:" || !url.hostname || url.username || url.password || /[\s\\<>]/.test(policy.escalationUrl)) {
        return "Escalation URL must be an HTTPS link without credentials.";
      }
    } catch {
      return "Escalation URL must be an HTTPS link without credentials.";
    }
  }
  if (policy.escalationEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(policy.escalationEmail)) {
    return "Enter a valid escalation email address.";
  }
  return "";
}

const fields = [
  ["role", "Assistant role", "Describe the assistant's role within your organisation.", 3],
  ["tone", "Tone of voice", "Describe the preferred tone.", 2],
  ["additionalInstructions", "Additional instructions", "Guidance for answers based on available portal content.", 4],
  ["specialistTopics", "Specialist topics", "Topics that may need a specialist response.", 3],
  ["escalationInstructions", "Escalation guidance", "When and how to direct a member to a person.", 3],
  ["escalationName", "Escalation contact name", "Name or team to contact.", 0],
  ["escalationUrl", "Escalation HTTPS link", "https://example.org/contact", 0],
  ["escalationEmail", "Escalation email", "team@example.org", 0],
];

export default function MemberAiResponsePolicy({ value, onChange, disabled }) {
  const update = (key, next) => onChange({ ...value, [key]: next });
  const updatePair = (index, key, next) => update("terminology", value.terminology.map((pair, i) => i === index ? { ...pair, [key]: next } : pair));
  return (
    <section className="space-y-5 border-t border-slate-600 pt-6" aria-label="AI response policy">
      <div>
        <h3 className="font-semibold text-slate-100">Response policy</h3>
        <p className="mt-1 text-sm text-slate-400">Preferences guide answers grounded in accessible published portal content; they are not guarantees and cannot change access permissions or available sources.</p>
      </div>
      {fields.slice(0, 2).map(([key, label, placeholder, rows]) => (
        <div className="space-y-2" key={key}>
          <Label htmlFor={`ai-policy-${key}`} className="text-slate-200">{label}</Label>
          <Textarea id={`ai-policy-${key}`} value={value[key]} onChange={event => update(key, event.target.value)} rows={rows} maxLength={LIMITS[key]} disabled={disabled} placeholder={placeholder} className={fieldClass} data-testid={`input-ai-policy-${key}`} />
        </div>
      ))}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="ai-policy-answerLength" className="text-slate-200">Answer length</Label>
          <select id="ai-policy-answerLength" value={value.answerLength} disabled={disabled} onChange={event => update("answerLength", event.target.value)} className={selectClass} data-testid="select-ai-policy-answerLength">
            <option value="concise">Concise</option><option value="balanced">Balanced</option><option value="detailed">Detailed</option>
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="ai-policy-clarification" className="text-slate-200">Clarifying questions</Label>
          <select id="ai-policy-clarification" value={value.clarification} disabled={disabled} onChange={event => update("clarification", event.target.value)} className={selectClass} data-testid="select-ai-policy-clarification">
            <option value="when_needed">When needed</option><option value="ask_first">Ask first</option><option value="answer_directly">Answer directly where possible</option>
          </select>
        </div>
      </div>
      {[["multipleApproaches", "Offer multiple approaches"], ["nextSteps", "Include next steps"]].map(([key, label]) => (
        <div key={key} className="flex items-center justify-between gap-4 rounded-lg border border-slate-600 bg-slate-900/50 p-3">
          <Label htmlFor={`ai-policy-${key}`} className="text-slate-200">{label}</Label>
          <Switch id={`ai-policy-${key}`} checked={value[key]} disabled={disabled} onCheckedChange={next => update(key, next)} />
        </div>
      ))}
      <div className="space-y-3">
        <Label className="text-slate-200">Preferred terminology</Label>
        <p className="text-xs text-slate-400">Up to 30 pairs. Both fields are required for each pair.</p>
        {value.terminology.map((pair, index) => (
          <div className="flex flex-wrap items-center gap-2" key={index}>
            <Input aria-label={`Term ${index + 1}`} value={pair.term} maxLength={100} disabled={disabled} onChange={event => updatePair(index, "term", event.target.value)} placeholder="Term" className={`min-w-32 flex-1 ${fieldClass}`} />
            <Input aria-label={`Preferred wording ${index + 1}`} value={pair.preferred} maxLength={100} disabled={disabled} onChange={event => updatePair(index, "preferred", event.target.value)} placeholder="Preferred wording" className={`min-w-32 flex-1 ${fieldClass}`} />
            <Button type="button" variant="outline" className={outlineClass} disabled={disabled} onClick={() => update("terminology", value.terminology.filter((_, i) => i !== index))} aria-label={`Remove term ${index + 1}`}>Remove</Button>
          </div>
        ))}
        <Button type="button" variant="outline" className={outlineClass} disabled={disabled || value.terminology.length >= 30} onClick={() => update("terminology", [...value.terminology, { term: "", preferred: "" }])}>Add term</Button>
      </div>
      {fields.slice(2).map(([key, label, placeholder, rows]) => (
        <div className="space-y-2" key={key}>
          <Label htmlFor={`ai-policy-${key}`} className="text-slate-200">{label}</Label>
          {rows ? <Textarea id={`ai-policy-${key}`} value={value[key]} onChange={event => update(key, event.target.value)} rows={rows} maxLength={LIMITS[key]} disabled={disabled} placeholder={placeholder} className={fieldClass} data-testid={`input-ai-policy-${key}`} /> :
            <Input id={`ai-policy-${key}`} value={value[key]} onChange={event => update(key, event.target.value)} maxLength={LIMITS[key]} disabled={disabled} placeholder={placeholder} className={fieldClass} data-testid={`input-ai-policy-${key}`} />}
        </div>
      ))}
      <Button type="button" variant="outline" className={outlineClass} disabled={disabled || JSON.stringify(value) === JSON.stringify(DEFAULT_RESPONSE_POLICY)} onClick={() => onChange(normalizePolicy(DEFAULT_RESPONSE_POLICY))}>Reset response policy to defaults</Button>
    </section>
  );
}