import archiver from "archiver";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const OUT = "reports/seo-board-report.docx";
mkdirSync(dirname(OUT), { recursive: true });

const escapeXml = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

function run(text, { bold = false, italic = false, size, color, font = "Calibri" } = {}) {
  const rPr = [
    `<w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:cs="${font}"/>`,
    bold ? `<w:b/><w:bCs/>` : "",
    italic ? `<w:i/><w:iCs/>` : "",
    size ? `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>` : "",
    color ? `<w:color w:val="${color}"/>` : "",
  ].join("");
  return `<w:r><w:rPr>${rPr}</w:rPr><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}

function para(runs, { spacingAfter = 80, spacingBefore = 0, numId, ilvl = 0, indentLeft, hanging } = {}) {
  const pPr = [];
  pPr.push(`<w:spacing w:before="${spacingBefore}" w:after="${spacingAfter}" w:line="260" w:lineRule="auto"/>`);
  if (numId !== undefined) {
    pPr.push(`<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>`);
  }
  if (indentLeft !== undefined) {
    const hangAttr = hanging !== undefined ? ` w:hanging="${hanging}"` : "";
    pPr.push(`<w:ind w:left="${indentLeft}"${hangAttr}/>`);
  }
  return `<w:p><w:pPr>${pPr.join("")}</w:pPr>${runs.join("")}</w:p>`;
}

const title = para(
  [run("SEO & Link-Preview Capability", { bold: true, size: 32 })],
  { spacingAfter: 40 }
);
const subtitle = para(
  [run("Graduate Futures Institute — Board update, May 2026", { italic: true, size: 22, color: "595959" })],
  { spacingAfter: 200 }
);

function heading(text) {
  return para([run(text, { bold: true, size: 26, color: "1F3864" })], {
    spacingBefore: 160,
    spacingAfter: 60,
  });
}

function body(text, opts = {}) {
  return para([run(text, { size: 22 })], { spacingAfter: opts.after ?? 80 });
}

// Bullet indent: 360 twips = 0.25", hanging 240
function bullet(runs) {
  return para(runs, { numId: 1, ilvl: 0, spacingAfter: 40, indentLeft: 360, hanging: 240 });
}

function bulletRich(lead, rest) {
  return bullet([run(lead, { bold: true, size: 22 }), run(rest, { size: 22 })]);
}

function bulletPlain(text) {
  return bullet([run(text, { size: 22 })]);
}

const bodyContent = [
  title,
  subtitle,

  heading("Headline"),
  body(
    "The GFI website is now fully equipped for search-engine discovery and produces branded, professional link previews wherever GFI content is shared.",
    { after: 80 }
  ),

  heading("Why it matters"),
  body(
    "GFI's public pages are now eligible for indexing by Google and Bing, increasing organic reach to prospective members, course attendees, and supporters. When GFI staff or members share a link in chat, email, or on social channels, it renders as a branded GFI preview card rather than a bare URL — strengthening GFI's brand consistency and credibility across every touchpoint.",
    { after: 80 }
  ),

  heading("What was delivered"),
  bulletRich(
    "Search-engine discoverability: ",
    "a GFI XML sitemap, indexing rules aligned to GFI's preferences, and server-side rendering for crawlers so search engines see fully-formed GFI pages instead of an empty shell."
  ),
  bulletRich(
    "Rich link previews (social unfurls): ",
    "GFI-branded Open Graph and Twitter Card metadata, with bespoke previews for events, complex events, articles, news, jobs, forum threads, resources, directories, photo galleries, fundraising campaigns, member profiles, public forms, and content-managed pages — each carrying its own title, summary, and image, with graceful fallback to GFI's default branding."
  ),
  bulletRich(
    "Editorial control: ",
    "GFI editors can set a custom social title, description, and share image per page or item directly from the existing editor, and configure GFI-wide defaults from the branding settings."
  ),
  bulletRich(
    "Reliability: ",
    "a same-origin image proxy ensures GFI preview cards render correctly on platforms that block third-party hosts, including Slack, WhatsApp, LinkedIn, iMessage, Facebook, and X."
  ),

  heading("Outcome"),
  bulletPlain("GFI pages are eligible for indexing by major search engines."),
  bulletPlain(
    "Branded GFI preview cards appear on every major chat and social platform when a link is shared."
  ),
  bulletPlain(
    "A consistent unfurl experience now spans every public page type across the GFI website."
  ),

  heading("Note on scope"),
  body(
    "This represents a strategic enhancement that broadens GFI's reach and online presentation, rather than corrective remediation."
  ),
];

const sectPr = `<w:sectPr>
  <w:pgSz w:w="11906" w:h="16838"/>
  <w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/>
  <w:cols w:space="708"/>
  <w:docGrid w:linePitch="360"/>
</w:sectPr>`;

const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
${bodyContent.join("\n")}
${sectPr}
</w:body>
</w:document>`;

const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>
        <w:sz w:val="22"/>
        <w:szCs w:val="22"/>
      </w:rPr>
    </w:rPrDefault>
    <w:pPrDefault>
      <w:pPr>
        <w:spacing w:after="80" w:line="260" w:lineRule="auto"/>
      </w:pPr>
    </w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:qFormat/>
  </w:style>
</w:styles>`;

const numberingXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0">
      <w:start w:val="1"/>
      <w:numFmt w:val="bullet"/>
      <w:lvlText w:val="\u2022"/>
      <w:lvlJc w:val="left"/>
      <w:pPr>
        <w:ind w:left="360" w:hanging="240"/>
      </w:pPr>
      <w:rPr>
        <w:rFonts w:ascii="Symbol" w:hAnsi="Symbol" w:hint="default"/>
      </w:rPr>
    </w:lvl>
  </w:abstractNum>
  <w:num w:numId="1">
    <w:abstractNumId w:val="0"/>
  </w:num>
</w:numbering>`;

const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;

const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;

const documentRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
</Relationships>`;

const corePropsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>SEO &amp; Link-Preview Capability — Board Report</dc:title>
  <dc:creator>Membership Platform</dc:creator>
  <cp:lastModifiedBy>Membership Platform</cp:lastModifiedBy>
</cp:coreProperties>`;

const appPropsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
  <Application>Node DOCX Generator</Application>
</Properties>`;

const output = createWriteStream(OUT);
const archive = archiver("zip", { zlib: { level: 9 } });

const done = new Promise((resolve, reject) => {
  output.on("close", resolve);
  output.on("error", reject);
  archive.on("error", reject);
});

archive.pipe(output);
archive.append(contentTypesXml, { name: "[Content_Types].xml" });
archive.append(rootRelsXml, { name: "_rels/.rels" });
archive.append(documentXml, { name: "word/document.xml" });
archive.append(stylesXml, { name: "word/styles.xml" });
archive.append(numberingXml, { name: "word/numbering.xml" });
archive.append(documentRelsXml, { name: "word/_rels/document.xml.rels" });
archive.append(corePropsXml, { name: "docProps/core.xml" });
archive.append(appPropsXml, { name: "docProps/app.xml" });
await archive.finalize();
await done;

console.log("Wrote", OUT);
