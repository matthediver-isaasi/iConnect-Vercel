"""Offline PDF checks, bookmarks and page images.

Run after the build: python scripts/validate-dd-renewals-user-guide.py
Requires the project's pymupdf dependency. Images are temporary, not deliverables.
"""
from pathlib import Path
import re
import fitz

base = Path("guides/direct-debit-membership-renewals-user-guide")
source = base.with_suffix(".md").read_text()
pdf_path = base.with_suffix(".pdf")
doc = fitz.open(pdf_path)
headings = re.findall(r"^## (.+)$", source, re.M)
toc = []
for heading in headings:
    matches = [
        page.number + 1 for page in doc
        if page.number > 0 and any(heading in block[4].replace("\n", " ").strip()
                                  for block in page.get_text("blocks"))
    ]
    # Contents is on the cover; exclude its repeated title links above.
    if heading == "Contents":
        matches = [1]
    assert matches, f"Missing heading: {heading}"
    toc.append([1, heading, matches[-1]])
doc.set_toc(toc)
doc.set_metadata({
    "title": "Direct Debit Membership Renewals — User Guide",
    "subject": "Membership administration: consent, renewal, invoicing and member actions",
    "author": "Membership administration",
    "keywords": "Direct Debit, GoCardless, membership, renewals, user guide",
})
doc.saveIncr()
links = [link for page in doc for link in page.get_links()]
internal = [link for link in links if link["kind"] in (fitz.LINK_GOTO, fitz.LINK_NAMED) and "page" in link]
assert len(internal) >= 8, "Contents links missing"
assert all(0 <= link["page"] < len(doc) for link in internal)
for page in doc:
    assert page.get_text().strip(), f"Empty page {page.number + 1}"
    for block in page.get_text("blocks"):
        x0, y0, x1, y1 = block[:4]
        assert 20 <= x0 < x1 <= page.rect.width - 20, (page.number + 1, block)
        assert 10 <= y0 < y1 <= page.rect.height - 10, (page.number + 1, block)
# Compare substantive words, ignoring Markdown syntax/links and wrapping.
plain = re.sub(r"\[([^]]+)\]\([^)]+\)", r"\1", source)
plain = re.sub(r"[#*`]", "", plain)
normalize = lambda s: re.sub(r"\s+", "", s).replace("\u2011", "-")
text = normalize("".join(page.get_text() for page in doc))
for line in plain.splitlines():
    line = re.sub(r"^\s*(?:[-+]|\d+\.)\s+", "", line)
    if not line.strip() or re.fullmatch(r"[\s:-]+", line):
        continue
    # Table cells are tested independently because PDF reading order is tabular.
    for phrase in re.split(r"\s{2,}|\|", line.strip()):
        phrase = phrase.strip()
        if len(phrase) > 20:
            assert normalize(phrase) in text, f"Missing text: {phrase}"
out = Path("/tmp/dd-renewals-guide")
out.mkdir(exist_ok=True)
for page in doc:
    page.get_pixmap(matrix=fitz.Matrix(1.25, 1.25)).save(out / f"page-{page.number+1:02}.png")
# Contact sheet keeps every page available for a quick layout inspection.
sheet = fitz.open()
columns, rows = 3, (len(doc) + 2) // 3
canvas = sheet.new_page(width=columns*300, height=rows*425)
for i, page in enumerate(doc):
    rect = fitz.Rect((i % columns)*300, (i // columns)*425,
                     (i % columns+1)*300, (i // columns+1)*425)
    canvas.insert_image(rect, pixmap=page.get_pixmap())
canvas.get_pixmap().save(out / "contact-sheet.png")
print(f"PASS: {len(doc)} pages; {len(internal)} contents links; {len(toc)} bookmarks; source text and page bounds checked.")