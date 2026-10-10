import { Link } from "react-router-dom";
import { formatBounceDate } from "./bounceModel.mjs";

export default function BounceDetails({ item, showMembers = true }) {
  return <dl className="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2">
    <Detail label="Email"><span className="break-all">{item.email}</span></Detail>
    <Detail label="Status">{item.resolved_at ? "Resolved" : "Hard bounce · Campaign emails paused"}</Detail>
    <Detail label="First bounced">{formatBounceDate(item.first_bounced_at)}</Detail>
    <Detail label="Last bounced">{formatBounceDate(item.last_bounced_at)}</Detail>
    <Detail label="SMTP code">{item.smtp_code || "Not recorded"}</Detail>
    <Detail label="Campaign">{item.campaign_name || item.campaign_id || "Not recorded"}</Detail>
    <div className="sm:col-span-2"><Detail label="Bounce reason"><span className="whitespace-pre-wrap break-words">{item.reason || "No reason provided by the email provider."}</span></Detail></div>
    {showMembers && <div className="sm:col-span-2"><Detail label="Members sharing this address">{item.members?.length ? <div className="flex flex-wrap gap-x-4 gap-y-2">{item.members.map((member) => <Link key={member.id} to={`/members/${encodeURIComponent(member.id)}`} className="font-medium text-primary underline underline-offset-4">{member.name || "Unnamed member"}</Link>)}</div> : "No linked members"}</Detail></div>}
    {item.resolved_at && <><Detail label="Resolved">{formatBounceDate(item.resolved_at)}</Detail><Detail label="Resolution note"><span className="whitespace-pre-wrap break-words">{item.resolution_note || "Not recorded"}</span></Detail></>}
  </dl>;
}

function Detail({ label, children }) {
  return <div><dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt><dd className="mt-1 text-slate-800">{children}</dd></div>;
}
