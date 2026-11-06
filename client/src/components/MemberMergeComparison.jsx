import { useId } from "react";

/**
 * Controlled comparison: member order is fixed and only explicit choices are
 * supplied by the parent. Unchosen fields follow the current survivor.
 */
export default function MemberMergeComparison({
  members,
  targetId,
  onTargetChange,
  rows,
  choices,
  memberClasses = null,
  financialSummaries = null,
  onChoose,
  disabled = false,
}) {
  const instanceId = useId();
  const sections = ["Profile fields", "Custom fields"]
    .map((label) => ({
      label,
      rows: rows.filter((row) => row.section === label),
    }))
    .filter((section) => section.rows.length > 0);
  const rowCount = 1 + sections.length + rows.length;

  return (
    <div className="min-w-0 space-y-3">
      <p id={`${instanceId}-instructions`} className="text-sm text-slate-600">
        Choose the record to keep, then select the value to use for each field.
        Fields without an explicit choice follow the record you keep.
      </p>
      <div
        className="overflow-x-auto rounded-lg border border-slate-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-600"
        tabIndex={0}
        role="region"
        aria-label="Member records comparison"
        aria-describedby={`${instanceId}-instructions`}
      >
        <div className="grid min-w-[560px] grid-cols-2 gap-x-3 p-2">
          {members.map((member) => {
            const isSurvivor = member.id === targetId;
            const name =
              `${member.first_name || ""} ${member.last_name || ""}`.trim() ||
              member.email ||
              `Member ${member.id}`;

            return (
              <div
                key={member.id}
                data-testid={`column-${member.id}`}
                className={`grid min-w-0 rounded-md px-3 pb-3 ${
                  isSurvivor ? "bg-yellow-50" : "bg-slate-50"
                }`}
                style={{
                  gridRow: `1 / span ${rowCount}`,
                  gridTemplateRows: "subgrid",
                }}
              >
                <div className="min-w-0 border-b border-slate-200 pb-4 pt-3">
                  <label
                    className={`mb-3 flex items-center gap-2 rounded-sm text-sm font-medium text-slate-800 ${
                      disabled ? "cursor-not-allowed" : "cursor-pointer"
                    }`}
                  >
                    <input
                      type="radio"
                      name={`${instanceId}-survivor`}
                      value={member.id}
                      checked={isSurvivor}
                      onChange={() => onTargetChange(member.id)}
                      disabled={disabled}
                      data-testid={`survivor-${member.id}`}
                      aria-label={`Keep ${name} as the surviving record`}
                      className="h-4 w-4 shrink-0 accent-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-600 disabled:cursor-not-allowed"
                    />
                    Keep this record
                  </label>
                  <p className="whitespace-pre-wrap font-semibold text-slate-900 [overflow-wrap:anywhere]">
                    {name}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600 [overflow-wrap:anywhere]">
                    {member.email || "No email address"}
                  </p>
                  {memberClasses && (
                    <p data-testid={`member-class-${member.id}`} className="mt-1 whitespace-pre-wrap text-sm text-slate-600 [overflow-wrap:anywhere]">
                      <span className="font-medium">Member class:</span> {memberClasses[member.id] || "Not set"}
                    </p>
                  )}
                  <div className="mt-2 space-y-2 text-xs [overflow-wrap:anywhere]" data-testid={`financial-${member.id}`}>
                    <p className="font-medium text-slate-800">
                      {financialSummaries?.[member.id]?.membership?.state === 'active_paid'
                        ? 'Active paid membership'
                        : financialSummaries?.[member.id]?.membership?.state === 'none'
                          ? 'No active paid membership' : 'Membership verification unavailable'}
                    </p>
                    <p className="rounded border border-blue-300 bg-blue-50 p-2 font-medium text-blue-900">
                      Direct Debit: {financialSummaries?.[member.id]?.directDebit?.active ? 'Active mandate. ' : ''}
                      {!financialSummaries?.[member.id]?.directDebit?.verified
                        ? 'Verification incomplete'
                        : financialSummaries[member.id].directDebit.statuses.length
                          ? financialSummaries[member.id].directDebit.statuses.map(status => status.replaceAll('_', ' ')).join(', ')
                          : 'No member-owned mandate'}
                    </p>
                  </div>
                  <p className="mt-2 text-xs font-medium text-slate-600">
                    {isSurvivor ? "Surviving record" : "Other record"}
                  </p>
                </div>

                {sections.flatMap((section) => [
                  <h3
                    key={`section-${section.label}`}
                    className="pb-2 pt-5 text-xs font-semibold uppercase tracking-wide text-slate-600"
                  >
                    {section.label}
                  </h3>,
                  ...section.rows.map((row) => {
                    const selected =
                      (choices[row.key] ?? targetId) === member.id;

                    return (
                      <div key={row.key} className="min-w-0 pb-3">
                        <label
                          className={`flex h-full min-w-0 items-start gap-2 rounded-md border p-3 text-sm focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-slate-600 ${
                            selected
                              ? "border-green-300 bg-green-50"
                              : "border-slate-200 bg-white"
                          } ${
                            disabled
                              ? "cursor-not-allowed"
                              : "cursor-pointer"
                          }`}
                        >
                          <input
                            type="radio"
                            name={`${instanceId}-value-${row.key}`}
                            value={member.id}
                            checked={selected}
                             onClick={() => onChoose(row.key, member.id)}
                            onChange={() => onChoose(row.key, member.id)}
                            disabled={disabled}
                            data-testid={`value-${row.key}-${member.id}`}
                            aria-label={`${row.label}: use value from ${name}`}
                            aria-describedby={`${instanceId}-value-${row.key}-${member.id}`}
                            className="mt-0.5 h-4 w-4 shrink-0 accent-green-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-green-800 disabled:cursor-not-allowed"
                          />
                          <span className="block min-w-0 flex-1">
                            <span className="block font-medium text-slate-600 [overflow-wrap:anywhere]">
                              {row.label}
                            </span>
                            <span
                              id={`${instanceId}-value-${row.key}-${member.id}`}
                              className="mt-1 block whitespace-pre-wrap text-slate-900 [overflow-wrap:anywhere]"
                            >
                              {row.values[member.id] ?? "—"}
                            </span>
                            <span
                              className={`mt-3 block text-xs font-medium ${
                                selected ? "text-green-800" : "text-slate-500"
                              }`}
                            >
                              {selected ? "Selected value" : "Not selected"}
                            </span>
                          </span>
                        </label>
                      </div>
                    );
                  }),
                ])}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
