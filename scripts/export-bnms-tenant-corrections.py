"""Produce a single tenant-facing worksheet from the completed read-only audit."""
import json
from pathlib import Path
from openpyxl import Workbook, load_workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.comments import Comment
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.utils import get_column_letter

ROOT = Path("generated-artifacts/bnms-completion/2026-11-03T07-04-08.075Z")
audit = json.loads((ROOT / "audit.json").read_text())
snapshot = json.loads((ROOT / "snapshot.json").read_text())
resources = {r["id"]: r for r in snapshot["resources"]}
categories = {c["name"]: c["subcategories"] for c in snapshot["categories"]}
topics = list(audit["topicMapping"])
headers = ["Reference", "What to fix", "Title", "Resource URL", "Date", "Member Only",
           "Collection", "Resource Type", "Team notes", "Brief Description"] + topics + ["Source reference"]
book = Workbook()
sheet = book.active
sheet.title = "Resources to check"
sheet.append(["BNMS resources — please correct the highlighted cells"])
sheet.merge_cells("A1:J1")
sheet.append(["Yellow = correct or confirm this cell. Read ‘What to fix’, then edit the data or add Team notes. Expand the + columns for optional description/topic details."])
sheet.merge_cells("A2:J2")
sheet.append(["All 257 original rows are included. Nothing has been uploaded. Two proposals remain on hold; completing this sheet does not approve an upload."])
sheet.merge_cells("A3:J3")
sheet.append(headers)
yellow = PatternFill("solid", fgColor="FFF2CC")
blue = PatternFill("solid", fgColor="17365D")
index = {h: i + 1 for i, h in enumerate(headers)}
expected_highlights = []

for row in audit["rows"]:
    source = row["source"]
    actions = []
    marked = {}

    def flag(field, message, detail=None):
        if message not in actions:
            actions.append(message)
        marked.setdefault(field, []).append(detail or message)

    for issue in row["issues"]:
        if issue == "invalid_url":
            flag("Resource URL", "Enter the full resource link, starting with https:// or http://.")
        elif issue == "missing_title":
            flag("Title", "Add the resource title.")
        elif issue == "invalid_date":
            flag("Date", "Confirm the date as YYYY-MM-DD; do not guess a day for a month/year or a numeric code.")
        elif issue == "missing_or_invalid_access":
            flag("Member Only", "Choose Yes for members only, or No for public access.")
        elif issue.startswith("missing_classification:"):
            field = issue.split(":")[1]
            flag(field, f"Choose a {field} from the dropdown.")
        elif issue.startswith("missing_taxonomy:"):
            _, parent, value = issue.split(":", 2)
            field = parent if parent in index else next((h for h, v in audit["topicMapping"].items() if v == value), "Team notes")
            flag(field, f"‘{value}’ is not available under {parent}. Choose a valid value or explain the required category in Team notes.",
                 "Current choices: " + ", ".join(categories.get(parent, [])))
        elif issue == "title_only_candidate_requires_review":
            candidates = [resources[i] for i in row["titleCandidates"] if i in resources]
            detail = "\n".join(f'{c["title"]}: {c.get("target_url", "")}' for c in candidates)
            flag("Resource URL", "A resource with this title already exists. Confirm its correct link, or explain in Team notes why this is a different resource.", detail)
        elif "source_duplicate" in issue:
            others = next((g["references"] for g in audit["duplicateGroups"] if row["reference"] in g["references"]), [])
            flag("Resource URL", "This link is repeated. Say which reference to keep in Team notes; do not delete rows.",
                 "Repeated references: " + ", ".join(others))
            group = next((g for g in audit["duplicateGroups"] if row["reference"] in g["references"]), {})
            for field in group.get("differingFields", []):
                if field in index:
                    flag(field, "Confirm the highlighted values where repeated rows disagree.")
        elif issue == "historical_hold_requires_explicit_resolution":
            flag("Resource URL", "The original file had conflicting links. Confirm the intended resource link in Team notes.")
        elif issue.startswith("invalid_marker:"):
            field = issue.split(":", 1)[1]
            flag(field, f"Set {field} to Yes, No or blank.")
        else:
            flag("Team notes", "Please ask the administrator to review this row before upload.", issue)
    if row["reference"] in {r["reference"] for r in audit["safeSubset"]}:
        actions = ["ON HOLD — no correction required now. Await the administrator’s decision; do not approve or upload."]
    elif row["status"] == "unchanged":
        actions = ["No correction needed — already matches the existing resource."]
    sheet.append([("\n".join(actions) if h == "What to fix" else source.get(h, "")) for h in headers])
    n = sheet.max_row
    for cell in sheet[n]:
        # Keep user-supplied text literal, never executable spreadsheet formulas.
        if isinstance(cell.value, str):
            cell.data_type = "s"
        cell.alignment = Alignment(vertical="top", wrap_text=True)
        cell.font = Font(name="Calibri", size=11)
    for field, notes in marked.items():
        cell = sheet.cell(n, index[field])
        cell.fill = yellow
        cell.comment = Comment("\n\n".join(dict.fromkeys(notes)), "BNMS review")
        expected_highlights.append((n, index[field]))
    sheet.row_dimensions[n].height = max(65, min(160, 30 * len(actions)))

for cell in sheet[4]:
    cell.fill = blue
    cell.font = Font(name="Calibri", bold=True, color="FFFFFF")
    cell.alignment = Alignment(wrap_text=True, vertical="center")
sheet.row_dimensions[4].height = 32
sheet["A1"].font = Font(size=16, bold=True, color="17365D")
for r in [2, 3]:
    sheet.cell(r, 1).alignment = Alignment(wrap_text=True, vertical="center")
    sheet.row_dimensions[r].height = 32
for name, width in {"Reference": 23, "What to fix": 65, "Title": 42, "Resource URL": 46,
                    "Date": 18, "Member Only": 16, "Collection": 25, "Resource Type": 27,
                    "Team notes": 42, "Brief Description": 55, "Source reference": 45}.items():
    sheet.column_dimensions[get_column_letter(index[name])].width = width
for topic in topics:
    sheet.column_dimensions[get_column_letter(index[topic])].width = 20
# Optional details are retained but collapsed, so the main sheet stays approachable.
last = get_column_letter(len(headers))
sheet.column_dimensions.group("J", last, hidden=True)
sheet.sheet_properties.outlinePr.summaryRight = False
sheet.freeze_panes = "C5"
sheet.auto_filter.ref = f"A4:{last}{sheet.max_row}"
sheet.sheet_view.zoomScale = 80
for field, choices in {"Member Only": ["Yes", "No"], "Collection": categories["Collection"],
                       "Resource Type": categories["Resource Type"]}.items():
    validation = DataValidation(type="list", formula1='"' + ",".join(choices) + '"', allow_blank=True)
    validation.promptTitle = field
    validation.prompt = "Choose a listed value. If unsure, explain in Team notes."
    validation.showInputMessage = True
    validation.showErrorMessage = True
    validation.error = "Choose a listed value, or leave blank and explain in Team notes."
    sheet.add_data_validation(validation)
    col = get_column_letter(index[field])
    validation.add(f"{col}5:{col}{sheet.max_row}")
sheet.print_title_rows = "1:4"
sheet.sheet_properties.pageSetUpPr.fitToPage = True
sheet.page_setup.orientation = "landscape"
sheet.page_setup.paperSize = sheet.PAPERSIZE_A3
sheet.page_setup.fitToWidth = 1
sheet.page_setup.fitToHeight = 0
sheet.print_options.horizontalCentered = True
sheet.print_area = f"A1:I{sheet.max_row}"
out = ROOT / "BNMS-simple-corrections.xlsx"
book.save(out)

# Read-back checks cover row accounting, literal source preservation and highlights.
check = load_workbook(out)
assert check.sheetnames == ["Resources to check"]
ws = check.active
assert ws.max_row == 261
for n, row in enumerate(audit["rows"], start=5):
    for h in headers:
        if h == "What to fix":
            continue
        assert (ws.cell(n, index[h]).value or "") == (row["source"].get(h, "") or ""), (n, h)
    assert ws.cell(n, index["What to fix"]).value
for r, c in expected_highlights:
    assert ws.cell(r, c).fill.fgColor.rgb == "00FFF2CC"
    assert ws.cell(r, c).comment
assert not any(c.data_type == "f" for cells in ws for c in cells)
print(f"{out}: verified 257 rows, one sheet, {len(expected_highlights)} highlighted cells; all source values preserved.")
