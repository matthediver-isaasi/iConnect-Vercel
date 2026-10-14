#!/usr/bin/env python3
"""Offline, review-only proposal. Private evidence stays in generated-artifacts."""
import csv
import datetime as dt
import glob
import hashlib
import html
import io
import json
import re
from collections import Counter
from pathlib import Path

import openpyxl

ROOT = Path("generated-artifacts/bnms-missing-150-review")
PATTERNS = [
    "*Student_data_to_import*.csv", "*Overseas_to_import*.csv",
    "*Overseas_to_import*.xlsx", "*UK_individual_members*.xlsx",
    "*Additional_individuals_to_import*.xlsx", "*BNMS_FINAL_79*.xlsx",
    "*Individuals_to_import*.xlsx",
]


def sha(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()


def key(value):
    return re.sub(r"[^a-z0-9]", "", str(value or "").lower())


def ident(value):
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value or "").strip()


def expiry(value):
    if isinstance(value, (dt.datetime, dt.date)):
        return value.strftime("%Y-%m-%d")
    text = ident(value)
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}( 00:00:00)?", text):
        return text[:10]
    match = re.fullmatch(r"(\d{1,2})/(\d{1,2})/(\d{2}|\d{4})", text)
    if not match:
        return None
    a, b, year = match.groups()
    try:
        # Existing reviewed source convention, not a generic UK assumption.
        return dt.date(int(year) + (2000 if len(year) == 2 else 0),
                       int(a if len(year) == 2 else b),
                       int(b if len(year) == 2 else a)).isoformat()
    except ValueError:
        return None


def source_rows():
    files = sorted({p for pattern in PATTERNS for p in glob.glob("attached_assets/" + pattern)})
    entries, provenance = [], []
    for filename in files:
        data = Path(filename).read_bytes()
        digest = sha(data)
        provenance.append({"path": filename, "sha256": digest})
        if filename.endswith(".csv"):
            # Preserve valid UTF-8, decode only invalid bytes as Windows-1252.
            text = data.decode("utf-8-sig", errors="surrogateescape")
            text = "".join(bytes([ord(c) - 0xDC00]).decode("cp1252", errors="replace")
                           if 0xDC80 <= ord(c) <= 0xDCFF else c for c in text)
            sheets = [(None, list(csv.reader(io.StringIO(text))))]
        else:
            book = openpyxl.load_workbook(filename, read_only=True, data_only=True)
            sheets = [(s.title, list(s.values)) for s in book]
            book.close()
        for sheet, rows in sheets:
            if not rows:
                continue
            headers = [key(h) for h in rows[0]]
            # The earliest July workbook has no entitlement columns.
            if "ymdatemembershipexpires" not in headers:
                continue
            for number, cells in enumerate(rows[1:], 2):
                row = dict(zip(headers, cells))
                if not any(cells):
                    continue
                entries.append({
                    "file": filename, "fileSha256": digest, "sheet": sheet, "row": number,
                    "rowSha256": sha(canonical([ident(c) for c in cells])),
                    "legacyId": ident(row.get("ymwebsitememberid")),
                    "email": ident(row.get("email")).lower(),
                    "expiryRaw": ident(row.get("ymdatemembershipexpires")),
                    "expiry": expiry(row.get("ymdatemembershipexpires")),
                    "class": ident(row.get("memberclass")),
                    "type": ident(row.get("ymmembershiptype")),
                    "status": ident(row.get("membershipstatus")),
                    "memberSince": ident(row.get("membersince")),
                })
    return entries, provenance


def assess_source(audit, live, sources, email):
    legacy_id = ident(live["preferences"].get("ym_web_site_member_id"))
    matches = []
    for source in sources:
        id_match = bool(legacy_id and source["legacyId"] == legacy_id)
        email_match = bool(email and source["email"] == email)
        if not (id_match or email_match):
            continue
        conflict = bool(source["legacyId"] and legacy_id and source["legacyId"] != legacy_id)
        agrees = (not conflict and source["expiry"] == audit["expiry"]
                  and source["class"] == audit["memberClass"]
                  and source["type"] == audit["legacyMembershipType"]
                  and source["status"] == "Active")
        matches.append({**source, "match": "legacy_id" if id_match else "email",
                        "identityConflict": conflict, "entitlementFieldsAgree": agrees})
    # Duplicate file copies are not independent corroboration.
    agrees = [m for m in matches if m["entitlementFieldsAgree"]]
    conflicts = [m for m in matches if not m["entitlementFieldsAgree"]]
    state = "source_conflict_requires_review" if conflicts else (
        "source_fields_corroborated" if agrees else "original_source_not_matched")
    return state, matches


def main():
    snapshot_bytes = (ROOT / "snapshot.json").read_bytes()
    snapshot = json.loads(snapshot_bytes)
    audit_bytes = Path(snapshot["auditPath"]).read_bytes()
    assert sha(audit_bytes) == snapshot["auditSha256"], "Audit changed"
    source, files = source_rows()
    csv_path = Path(".local/reports/bnms-memberships-invoices-2025.csv")
    csv_bytes = csv_path.read_bytes()
    with csv_path.open(encoding="utf-8-sig", newline="") as f:
        export = list(csv.DictReader(f))
    invoice_index = {}
    for row in export:
        invoice_index.setdefault(row["InvoiceNumber"], []).append(row)
    files.append({"path": str(csv_path), "sha256": sha(csv_bytes)})
    invoice_source = Path(glob.glob("attached_assets/Final_BNMS_invoices_to_import_01.01.25_to_date*")[0])
    invoice_hash = sha(invoice_source.read_bytes())
    files.append({"path": str(invoice_source), "sha256": invoice_hash})
    book = openpyxl.load_workbook(invoice_source, read_only=True, data_only=True)
    original_invoices = {sheet.title: list(sheet.values) for sheet in book}
    book.close()
    live_by_id = {r["id"]: r for r in snapshot["source"]}
    member_by_id = {r["id"]: r for r in snapshot["members"]}
    results = []
    for audit in sorted(snapshot["cohort"], key=lambda r: r["memberId"]):
        mid = audit["memberId"]
        live = live_by_id[mid]
        member = member_by_id[mid]
        p = live["preferences"]
        drift = (live["category"] != "requires_term_and_invoice_review"
                 or live["expiry"] != audit["expiry"] or p.get("member_class") != audit["memberClass"]
                 or p.get("ym_membership_type") != audit["legacyMembershipType"]
                 or member["email"].strip().lower() != audit["email"].strip().lower())
        state, matches = assess_source(audit, live, source, member["email"].strip().lower())
        invoices = [i for i in snapshot["invoices"] if i["member_id"] == mid]
        evidence = []
        for invoice in invoices:
            assert invoice["source_sha256"] == invoice_hash, "Invoice workbook changed"
            sheet = original_invoices[invoice["worksheet"]]
            original = sheet[invoice["source_row"] - 1]
            original_fields = dict(zip(sheet[0], original))
            assert ident(original_fields["iConnect member UUID"]) == mid, "Invoice owner mismatch"
            assert ident(original_fields["Invoice number"]) == invoice["invoice_number"], "Invoice number mismatch"
            linked = invoice_index.get(invoice["invoice_number"], [])
            evidence.append({"historical": invoice, "archivedExportMatches": linked,
                             "originalWorkbookVerified": True,
                             "originalRowSha256": sha(canonical([ident(c) for c in original])),
                             "exportLinkAuthority": "invoice_number_only_not_provider_revalidated",
                             "currentTermCoverage": "not_established"})
        dd = any(re.search(r"\bDD\b|direct debit", i.get("description") or "", re.I) for i in invoices)
        paid = sum(any(x["Status"] == "PAID" for x in e["archivedExportMatches"]) for e in evidence)
        reasons = ["No cohort-specific paid attestation",
                   "No verified invoice/payment establishing coverage through retained expiry",
                   "Historical commencement and amount are not established"]
        if drift:
            reasons.append("Live audit fields changed; re-review required")
        if state != "source_fields_corroborated":
            reasons.append(state)
        if dd:
            reasons.append("Historical invoice description mentions DD; reconcile before any repair")
        results.append({
            "memberId": mid, "name": audit["name"], "email": audit["email"],
            "memberClass": audit["memberClass"], "tierLabel": audit["legacyMembershipType"],
            "retainedExpiry": audit["expiry"], "audit": audit, "liveSource": live,
            "liveSourceSha256": sha(canonical(live)), "liveDrift": drift,
            "sourceState": state, "sourceMatches": matches, "invoiceEvidence": evidence,
            "historicalDDDescription": dd, "archivedPaidInvoiceCount": paid,
            "paidEntitlement": "unresolved", "decision": "HOLD_PENDING_EXPLICIT_APPROVAL",
            "holdReasons": reasons,
            "conditionalRepair": {
                "memberId": mid, "tierLabel": audit["legacyMembershipType"],
                "termEndDate": audit["expiry"], "termStartDate": None, "historicalAmount": None,
                "invoiceId": None, "paymentStatus": None, "paidAt": None,
                "authority": "none_until_member_specific_paid_confirmation",
                "renewalPolicy": None, "billingConsent": None,
            },
        })
    assert len(results) == len({r["memberId"] for r in results}) == 150
    summary = {
        "count": len(results), "classes": dict(Counter(r["memberClass"] for r in results)),
        "sourceStates": dict(Counter(r["sourceState"] for r in results)),
        "sourceDisagreementKinds": dict(Counter(
            "expiry_disagreement" if any(s["expiry"] != r["retainedExpiry"] for s in r["sourceMatches"])
            else "class_type_or_status_disagreement"
            for r in results if r["sourceState"] == "source_conflict_requires_review")),
        "liveDrift": sum(r["liveDrift"] for r in results),
        "membersWithHistoricalInvoices": sum(bool(r["invoiceEvidence"]) for r in results),
        "membersWithArchivedPaidInvoices": sum(r["archivedPaidInvoiceCount"] > 0 for r in results),
        "membersWithHistoricalDDDescriptions": sum(r["historicalDDDescription"] for r in results),
        "verifiedPaidEntitlements": 0, "readyToApply": 0, "held": 150, "writes": 0,
    }
    manifest = {
        "version": 1, "purpose": "conditional_proposal_not_executable", "approved": False,
        "asOf": snapshot["asOf"], "capturedAt": snapshot["capturedAt"], "tenant": snapshot["tenant"],
        "auditSha256": snapshot["auditSha256"], "snapshotSha256": sha(snapshot_bytes),
        "files": files, "summary": summary, "members": results,
        "approvalContract": [
            "Approve an explicit member-ID subset and this manifest SHA-256, not an open-ended cohort.",
            "Confirm paid entitlement through each listed expiry OR supply matched coverage/payment evidence.",
            "An operator attestation must remain distinct from provider settlement.",
            "Resolve source conflicts and historical DD-description holds individually first.",
            "Retain unknown commencement, amount, currency and invoice linkage as unknown.",
            "No provider writes, collections, renewals, policies, role/login changes or billing consent.",
            "Separate implementation authorization and live source/history/DD revalidation required before writes.",
            "Exclude newly changed, missing, paid-elsewhere or already-repaired members; never replace history.",
        ],
    }
    manifest_bytes = json.dumps(manifest, indent=2, ensure_ascii=False).encode() + b"\n"
    pin = sha(manifest_bytes)
    output = ROOT / "final"
    output.mkdir(exist_ok=True)
    with (output / "proposal.json").open("xb") as f:
        f.write(manifest_bytes)
    with (output / "member-review.csv").open("x", encoding="utf-8-sig", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["Member ID", "Name", "Email", "Member class", "Membership type",
                         "Retained expiry", "Original source assessment", "Source references",
                         "Historical invoice count", "Archived PAID invoice count",
                         "Historical DD description", "Live drift", "Paid entitlement",
                         "Decision", "Hold reasons", "Proposal SHA-256"])
        for r in results:
            values = [r["memberId"], r["name"], r["email"], r["memberClass"], r["tierLabel"],
                      r["retainedExpiry"], r["sourceState"],
                      "; ".join(f'{m["file"]} [{m["sheet"] or "CSV"} row {m["row"]}]' for m in r["sourceMatches"]),
                      len(r["invoiceEvidence"]), r["archivedPaidInvoiceCount"],
                      r["historicalDDDescription"], r["liveDrift"], r["paidEntitlement"],
                      r["decision"], "; ".join(r["holdReasons"]), pin]
            writer.writerow(["'" + str(v) if str(v).startswith(("=", "+", "-", "@")) else v for v in values])
    document = f"""<!doctype html><html lang="en"><meta charset="utf-8">
<title>BNMS 150-member evidence review</title>
<style>body{{font:16px/1.6 system-ui;max-width:960px;margin:40px auto;padding:0 24px;color:#182332}}
pre{{white-space:pre-wrap;background:#f2f4f6;padding:20px}}code{{overflow-wrap:anywhere}}
table{{border-collapse:collapse}}td,th{{border:1px solid #ccd3dc;padding:8px;text-align:left}}</style>
<h1>BNMS: 150-member evidence review</h1>
<p>Audit date: 14 October 2026. Live evidence captured: {html.escape(snapshot['capturedAt'])}.</p>
<p><strong>Review only. All 150 held. No database or provider writes.</strong></p>
<h2>Finding</h2><p>All selected members were outside the original September–December 2026
window. Retained expiry runs from 1 January 2027 to 1 July 2030. Imported Active status,
Member Since, invoice existence and historic PAID labels do not independently establish
paid entitlement through those dates. No commencement, annual amount or currency has been inferred.</p>
<pre>{html.escape(json.dumps(summary, indent=2))}</pre>
<h2>Evidence and limitations</h2><p>The private row-level CSV identifies each member,
source workbook/sheet/row, source disagreement, historical invoices and decision.
The pinned JSON preserves source-file and row hashes, complete selected local invoice metadata,
archived invoice-number matches, live source values and conditional repair fields.
Source corroboration is not proof that a particular import wrote the current record.</p>
<p>All 279 local historical invoice rows have null status and currency. Each was traced
to its pinned original invoice workbook, worksheet and source row, checking member ID and
invoice number. Source conflicts include 19 class/type/status differences (including
older overseas class labels) and two expiry differences; they are not all date errors.
The archived
invoice export spans 1 January 2025–12 August 2026; its PAID labels are historical evidence,
not fresh provider verification, and its references do not establish the retained term end.
Matching by invoice number alone is a review lead, not invoice-link authority.
No live provider reads or token refreshes were performed. Absence here is not proof of nonpayment.
Historical DD descriptions are review flags, not proof of a current mandate.</p>
<h2>Conditional repair proposal</h2><p>Only after explicit approval for named IDs and
their listed expiry dates: establish an expiry-only historical membership using the
retained type, with commencement, historical amount and invoice linkage left unknown.
If paid authority is operator confirmation, label it as such, never provider-verified settlement.
The current proposal assigns no paid status and is not executable. No membership year
is inferred from Member Since or by subtracting a year from expiry.</p>
<ul>{''.join('<li>'+html.escape(x)+'</li>' for x in manifest['approvalContract'])}</ul>
<p>The separately repaired individual and earlier approved cohorts confer no approval
on these 150 records. This review does not request blanket paid confirmation.</p>
<h2>Approval pin</h2><p>Proposal SHA-256: <code>{pin}</code></p>
<p>Snapshot SHA-256: <code>{sha(snapshot_bytes)}</code></p>
<p>Database migrations: none needed, applied or outstanding for this review.</p></html>"""
    with (output / "proposal.html").open("x", encoding="utf-8") as f:
        f.write(document)
    print(json.dumps({"summary": summary, "proposalSha256": pin}, indent=2))


if __name__ == "__main__":
    main()
