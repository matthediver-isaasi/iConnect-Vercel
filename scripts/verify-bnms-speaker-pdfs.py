"""Private local evidence only; do not print recipient names or PDF text."""
import json
from pathlib import Path
import fitz

root = Path("private/bnms-speaker-certificates")
report = json.loads((root / "execute-report.json").read_text())
results = []
for index, row in enumerate(report["rows"]):
    doc = fitz.open(root / (row["id"] + ".pdf"))
    text = " ".join(page.get_text() for page in doc)
    name = row["snapshot"]["speaker_name"]
    ok = name.casefold() in " ".join(text.split()).casefold()
    event_ok = all(value in text for value in ["Autumn Meeting 2026", "24", "25", "September"])
    results.append({"id": row["id"], "name_found": ok, "event_dates_found": event_ok, "pages": len(doc), "text": text})
    if index == 0:
        doc[0].get_pixmap(matrix=fitz.Matrix(1, 1)).save(root / "representative.png")
(root / "pdf-content-verification.json").write_text(json.dumps(results, indent=2))
assert all(r["name_found"] for r in results), "PDF recipient content mismatch (details private)"
assert all(r["event_dates_found"] for r in results), "PDF event content mismatch (details private)"
print(json.dumps({"pdfs": len(results), "recipient_names_verified": len(results)}))
