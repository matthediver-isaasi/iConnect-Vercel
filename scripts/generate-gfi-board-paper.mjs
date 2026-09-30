import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  PageNumber,
  Header,
  Footer,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  PageBreak,
  TableOfContents,
  LevelFormat,
  StyleLevel,
  ShadingType,
  convertInchesToTwip,
  PageOrientation,
} from 'docx';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const FONT = 'Calibri';
const BODY_SIZE = 22; // half-points => 11pt
const SMALL_SIZE = 20; // 10pt
const H1_SIZE = 32; // 16pt
const H2_SIZE = 26; // 13pt
const H3_SIZE = 24; // 12pt

const BRAND = '2E5C8A';
const MUTED = '595959';
const BORDER = 'BFBFBF';
const HEADER_FILL = 'EEF2F7';

function p(text, opts = {}) {
  const runs = Array.isArray(text)
    ? text
    : [{ text }];
  return new Paragraph({
    spacing: { after: opts.after ?? 120, before: opts.before ?? 0, line: 300 },
    alignment: opts.alignment,
    children: runs.map(
      (r) =>
        new TextRun({
          text: r.text,
          bold: r.bold,
          italics: r.italics,
          color: r.color,
          size: r.size ?? BODY_SIZE,
          font: FONT,
        }),
    ),
  });
}

function h1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 360, after: 180 },
    children: [new TextRun({ text, bold: true, size: H1_SIZE, color: BRAND, font: FONT })],
  });
}
function h2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 280, after: 140 },
    children: [new TextRun({ text, bold: true, size: H2_SIZE, color: BRAND, font: FONT })],
  });
}
function h3(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_3,
    spacing: { before: 200, after: 100 },
    children: [new TextRun({ text, bold: true, size: H3_SIZE, color: '333333', font: FONT })],
  });
}

function bullet(text, level = 0) {
  return new Paragraph({
    numbering: { reference: 'bullets', level },
    spacing: { after: 80, line: 290 },
    children: [new TextRun({ text, size: BODY_SIZE, font: FONT })],
  });
}

function bulletRich(parts, level = 0) {
  return new Paragraph({
    numbering: { reference: 'bullets', level },
    spacing: { after: 80, line: 290 },
    children: parts.map(
      (r) =>
        new TextRun({
          text: r.text,
          bold: r.bold,
          italics: r.italics,
          size: BODY_SIZE,
          font: FONT,
        }),
    ),
  });
}

function cell(text, opts = {}) {
  const isHeader = opts.header;
  const children = (Array.isArray(text) ? text : [text]).map((t) =>
    typeof t === 'string'
      ? new Paragraph({
          spacing: { after: 40, line: 280 },
          alignment: opts.alignment,
          children: [
            new TextRun({
              text: t,
              bold: isHeader || opts.bold,
              size: opts.size ?? BODY_SIZE,
              font: FONT,
              color: isHeader ? 'FFFFFF' : undefined,
            }),
          ],
        })
      : t,
  );
  return new TableCell({
    width: opts.width ? { size: opts.width, type: WidthType.PERCENTAGE } : undefined,
    shading: isHeader
      ? { type: ShadingType.CLEAR, color: 'auto', fill: BRAND }
      : opts.fill
        ? { type: ShadingType.CLEAR, color: 'auto', fill: opts.fill }
        : undefined,
    margins: { top: 100, bottom: 100, left: 120, right: 120 },
    children,
  });
}

function row(cells) {
  return new TableRow({ children: cells });
}

function table(rows, columnWidthsPct) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    columnWidths: columnWidthsPct,
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: BORDER },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: BORDER },
      left: { style: BorderStyle.SINGLE, size: 4, color: BORDER },
      right: { style: BorderStyle.SINGLE, size: 4, color: BORDER },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: BORDER },
      insideVertical: { style: BorderStyle.SINGLE, size: 4, color: BORDER },
    },
    rows,
  });
}

function spacer(size = 200) {
  return new Paragraph({ spacing: { after: size }, children: [new TextRun('')] });
}

function pageBreak() {
  return new Paragraph({ children: [new PageBreak()] });
}

// ===== Content =====

const coverChildren = [
  new Paragraph({
    spacing: { before: 2400, after: 240 },
    alignment: AlignmentType.CENTER,
    children: [
      new TextRun({
        text: 'GRADUATE FUTURES INSTITUTE',
        bold: true,
        size: 28,
        color: MUTED,
        font: FONT,
      }),
    ],
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 200 },
    children: [
      new TextRun({
        text: 'Information Security and Long-Term Support',
        bold: true,
        size: 48,
        color: BRAND,
        font: FONT,
      }),
    ],
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 600 },
    children: [
      new TextRun({
        text: 'Board Briefing',
        bold: true,
        size: 36,
        color: BRAND,
        font: FONT,
      }),
    ],
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 160 },
    children: [
      new TextRun({
        text: 'Prepared for the Board of Graduate Futures Institute',
        italics: true,
        size: 26,
        color: '333333',
        font: FONT,
      }),
    ],
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 2400 },
    children: [
      new TextRun({ text: 'May 2026 · Version 1.0', size: 24, color: MUTED, font: FONT }),
    ],
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 400 },
    children: [
      new TextRun({
        text: 'CONFIDENTIAL — BOARD PAPER',
        bold: true,
        size: 24,
        color: 'B00020',
        font: FONT,
      }),
    ],
  }),
  spacer(400),
  h3('Document control'),
  table(
    [
      row([
        cell('Version', { header: true, width: 20 }),
        cell('Date', { header: true, width: 20 }),
        cell('Author', { header: true, width: 35 }),
        cell('Status', { header: true, width: 25 }),
      ]),
      row([
        cell('1.0'),
        cell('May 2026'),
        cell('Platform vendor — Account team'),
        cell('Issued for board review'),
      ]),
    ],
    [20, 20, 35, 25],
  ),
  pageBreak(),
];

// Table of contents
const tocChildren = [
  h1('Contents'),
  new TableOfContents('Contents', {
    hyperlink: true,
    headingStyleRange: '1-3',
    stylesWithLevels: [
      new StyleLevel('Heading1', 1),
      new StyleLevel('Heading2', 2),
      new StyleLevel('Heading3', 3),
    ],
  }),
  pageBreak(),
];

// 2. Executive summary
const execSummary = [
  h1('1. Executive summary'),
  p(
    'Graduate Futures Institute (GFI) operates its membership, events, bookings, resources, and communications on a multi-tenant Software-as-a-Service platform hosted in the European Union. The platform applies modern, layered security controls — encryption in transit and at rest, strong identity management, strict logical separation between organisations, and role-based access — and is operated within a managed cloud environment that provides resilience, monitoring, and daily backups. All personal data processed for GFI remains within the EU (Frankfurt) in normal operation.',
  ),
  p(
    'The platform is aligned with the principles and controls of UK GDPR, the Data Protection Act 2018, ISO/IEC 27001, Cyber Essentials, and the SOC 2 Trust Services Criteria for Security, Availability, and Confidentiality. Card payments are handled exclusively through the payment provider\u2019s hosted components, which keeps GFI\u2019s PCI-DSS scope at SAQ-A. Where the platform is aligned to a standard but not formally certified against it, this paper says so explicitly.',
  ),
  p(
    'Alongside this security posture, the vendor proposes a five-year Priority support engagement covering response and resolution targets across four severity levels, named contacts on both sides, quarterly service reviews, included maintenance and security patching, and clear handling of change requests. The Board is invited to note the security position summarised in this paper and to approve the five-year Priority support engagement.',
  ),
  pageBreak(),
];

// 3. Platform overview
const platformOverview = [
  h1('2. Platform overview'),
  p(
    'The service used by GFI is a multi-tenant, web-based Software-as-a-Service application. It is accessed by authorised GFI staff, members, and the wider audiences GFI chooses to invite, through a standard web browser and supported integrations. It is delivered from an enterprise-grade serverless cloud environment in the European Union and is managed end-to-end by the vendor.',
  ),
  p(
    'The platform supports the core operating activities GFI relies on, including member records and identity management, events and bookings, payments and invoicing, learning resources, fundraising, communications, and reporting. These capabilities are delivered as a single integrated service so that information flows reliably between functions without GFI staff needing to reconcile separate systems.',
  ),
  p(
    'The service connects to a small number of trusted external providers that GFI is already familiar with — for example, the payment provider, the accounting platform, the transactional email provider, and the online meeting provider. Each integration is purpose-specific, limited to the minimum data necessary for the activity it supports, and described in the integrations section below.',
  ),
  p(
    'GFI\u2019s data is logically separated from every other organisation on the platform. Administrative permissions inside GFI\u2019s tenant are controlled by GFI through configurable roles, allowing senior staff to grant only the access each role needs.',
  ),
  pageBreak(),
];

// 4. Information security
const security = [
  h1('3. Information security'),
  p(
    'This section sets out, in board language, the controls that protect GFI\u2019s information on the platform. Where appropriate, the language describes capabilities and outcomes rather than internal technical detail.',
  ),

  h2('3.1 Hosting and data residency'),
  p(
    'The platform is delivered from an enterprise-grade serverless cloud, with the database operated by a major managed Postgres provider. All GFI data is hosted in the European Union, in the Frankfurt region. In normal operation no personal data is processed or stored outside the EU. Cloud and database providers used by the platform publish their own certifications, including ISO/IEC 27001 and SOC 2, and the platform is configured to operate within those certified environments.',
  ),

  h2('3.2 Encryption'),
  bullet('Data in transit is protected by TLS 1.2 or higher across all public endpoints.'),
  bullet(
    'Data at rest is encrypted by the managed database platform using industry-standard ciphers, with keys managed by the cloud provider.',
  ),
  bullet(
    'Sensitive third-party credentials that the platform must store on GFI\u2019s behalf (for example, integration tokens) are additionally encrypted at the application layer before they are written to storage, providing defence in depth.',
  ),

  h2('3.3 Identity and access management'),
  bullet(
    'Single sign-on is supported via Google and Microsoft, so GFI staff can use existing corporate identities where preferred.',
  ),
  bullet(
    'Locally managed passwords are stored using an industry-standard one-way hashing algorithm with per-user salting; the platform never stores or transmits passwords in clear text.',
  ),
  bullet(
    'Repeated failed sign-in attempts trigger an automatic lockout; password reset links are time-limited and single-use.',
  ),
  bullet(
    'Sessions are maintained using secure, HTTP-only, same-site cookies and time out after a defined period of inactivity.',
  ),
  bullet(
    'Two-factor authentication can be enforced for administrative roles where GFI requires it.',
  ),

  h2('3.4 Authorisation and tenant isolation'),
  p(
    'GFI\u2019s information is logically isolated from every other organisation on the platform. Isolation is enforced consistently across every layer of the application — the user interface, the application services, and the database — so that a request cannot retrieve information belonging to another tenant.',
  ),
  p(
    'Within GFI\u2019s tenant, access is controlled by configurable roles. Roles grant permission at a feature level and, where appropriate, at the level of individual fields, so that staff can be given precisely the access they need and no more. Administrative impersonation of a member account, where it is required for support purposes, is restricted to a small number of authorised roles and is fully audit-logged.',
  ),

  h2('3.5 Payments (PCI scope)'),
  p(
    'All card payments are entered by the payer directly into hosted components provided by the payment provider. The platform itself never sees, processes, or stores raw cardholder data: card numbers, expiry dates, and security codes are exchanged between the cardholder\u2019s browser and the payment provider\u2019s certified environment. The platform receives only tokens and payment outcomes. This design keeps GFI\u2019s PCI-DSS scope at SAQ-A, which is the lowest applicable merchant scope.',
  ),

  h2('3.6 Third-party integrations and data sharing'),
  p(
    'The platform integrates with a small set of trusted external providers, each with a specific operational purpose. The table below summarises the categories, the data shared, and the legal basis under UK GDPR. A full list of sub-processors is available to GFI on request under NDA.',
  ),
  table(
    [
      row([
        cell('Category', { header: true, width: 18 }),
        cell('Provider used by GFI', { header: true, width: 18 }),
        cell('Data shared', { header: true, width: 34 }),
        cell('Legal basis', { header: true, width: 30 }),
      ]),
      row([
        cell('Payments'),
        cell('Stripe'),
        cell('Payer name, email, billing details and the token returned by the payer\u2019s browser; no raw card data.'),
        cell('Performance of contract; legitimate interests for fraud prevention.'),
      ]),
      row([
        cell('Accounting'),
        cell('Xero'),
        cell('Invoice and credit-note metadata, contact details for billed parties.'),
        cell('Legal obligation (financial record-keeping); performance of contract.'),
      ]),
      row([
        cell('Transactional email'),
        cell('Mailgun'),
        cell('Recipient email address, message subject and body for transactional and campaign messages.'),
        cell('Performance of contract; legitimate interests; consent for marketing.'),
      ]),
      row([
        cell('Online meetings'),
        cell('Zoom'),
        cell('Attendee name and email for event registration; meeting metadata.'),
        cell('Performance of contract.'),
      ]),
      row([
        cell('Identity / SSO'),
        cell('Google, Microsoft'),
        cell('Sign-in token, verified email address, basic profile.'),
        cell('Performance of contract; user consent at sign-in.'),
      ]),
      row([
        cell('Calendar'),
        cell('Google Calendar / Microsoft 365'),
        cell('Event titles, times, and invitee email addresses where the user opts in.'),
        cell('User consent; legitimate interests.'),
      ]),
    ],
    [18, 18, 34, 30],
  ),

  h2('3.7 Backups and disaster recovery'),
  bullet(
    'The managed database platform performs daily backups and supports point-in-time recovery to any moment within the retention window.',
  ),
  bullet(
    'Restore procedures are documented and exercised by the vendor as part of routine operational practice.',
  ),
  bullet(
    'Service-level objectives are expressed in business terms: Recovery Point Objective of up to 24 hours, Recovery Time Objective of up to 8 business hours for a full restoration following a major incident.',
  ),
  bullet(
    'Daily configuration and content backups are retained for the period required to support point-in-time recovery; longer-term archival of specific records is provided through the platform\u2019s export functions.',
  ),

  h2('3.8 Logging, audit and monitoring'),
  bullet(
    'User actions on sensitive entities (member records, financial records, role changes, content publication) are captured in an audit trail.',
  ),
  bullet(
    'Background jobs, scheduled tasks, and external integrations record their execution status so issues can be diagnosed without exposing personal data.',
  ),
  bullet(
    'Application and infrastructure errors are monitored centrally; security-relevant events are reviewable by the vendor\u2019s support team.',
  ),
  bullet(
    'Administrative impersonation, bulk exports, and role changes generate explicit audit records that can be reviewed by GFI on request.',
  ),

  h2('3.9 Secrets and credential management'),
  p(
    'Operational secrets — for example, API keys for integrations and signing keys used by the platform — are held in the hosting provider\u2019s managed secret store, with strict per-environment separation between development, staging, and production. Secrets are never committed to source control and are never exposed to the user interface. Access to the production secret store is restricted to a small number of authorised vendor personnel.',
  ),

  h2('3.10 Secure development lifecycle'),
  bullet(
    'All code changes go through peer review before being merged into the main codebase.',
  ),
  bullet(
    'The application uses a strongly typed data access layer that helps prevent common classes of injection and data-shape errors.',
  ),
  bullet(
    'Dependencies are tracked and patched on a regular cadence; critical security advisories are addressed promptly.',
  ),
  bullet(
    'Changes are deployed to a staging environment before production; production deployments are staged and reversible.',
  ),
  bullet(
    'Security patches are applied on a defined schedule and out of band for critical advisories.',
  ),

  h2('3.11 People and process'),
  p(
    'Vendor staff are granted access to production environments on a strict need-to-know basis. Joiner, mover, and leaver processes ensure that access is provisioned, adjusted, and revoked in line with role changes. All staff are bound by written confidentiality obligations, and access to GFI\u2019s data is limited to the support personnel necessary to deliver this contract.',
  ),

  h2('3.12 Incident response'),
  p(
    'Incidents are classified by severity and routed through a documented escalation path. For incidents involving the personal data of GFI members, the vendor will notify GFI without undue delay and in any case within the timeframe needed to allow GFI to meet its UK GDPR obligation to notify the Information Commissioner\u2019s Office within 72 hours of becoming aware of a notifiable breach. Each material incident is followed by a written post-incident review.',
  ),

  h2('3.13 Data subject rights and GDPR'),
  bullet(
    'GFI can fulfil access, rectification, erasure, and portability requests for its members using the platform\u2019s built-in member management, export, and deletion functions.',
  ),
  bullet(
    'The vendor acts as a data processor for GFI under a written Data Processing Agreement that mirrors the requirements of Article 28 UK GDPR.',
  ),
  bullet(
    'A current list of sub-processors, including the categories above and their hosting locations, is maintained by the vendor and is available to GFI on request under NDA.',
  ),
  bullet(
    'Material changes to sub-processors are communicated to GFI with reasonable notice.',
  ),

  h2('3.14 Standards alignment'),
  p(
    'The table below summarises the standards the platform is aligned to. The wording is deliberately careful: where a standard is referenced as aligned, this means the controls described in this paper are implemented, not that the platform holds a formal certificate against that standard.',
  ),
  table(
    [
      row([
        cell('Standard', { header: true, width: 28 }),
        cell('Status', { header: true, width: 22 }),
        cell('How it applies to GFI', { header: true, width: 50 }),
      ]),
      row([
        cell('UK GDPR and Data Protection Act 2018'),
        cell('Compliant as data processor'),
        cell('Lawful basis recorded for each processing activity; processor obligations met under a written DPA; breach notification process supports GFI\u2019s 72-hour duty to the ICO; built-in functions support data subject rights.'),
      ]),
      row([
        cell('ISO/IEC 27001'),
        cell('Aligned (not certified)'),
        cell('Controls in the Annex A domains relevant to a cloud SaaS — access control, cryptography, operations security, supplier relationships, incident management, business continuity — are implemented as described in this paper.'),
      ]),
      row([
        cell('Cyber Essentials'),
        cell('Aligned to the five controls'),
        cell('Boundary protection, secure configuration, access control, malware protection, and patch management are operated at the hosting and application layers.'),
      ]),
      row([
        cell('SOC 2'),
        cell('Aligned to relevant TSC'),
        cell('Security, Availability, and Confidentiality criteria are reflected in encryption, access control, monitoring, and incident response. The hosting and database providers publish their own SOC 2 reports.'),
      ]),
      row([
        cell('PCI-DSS'),
        cell('SAQ-A via payment provider'),
        cell('Card data is handled exclusively by the payment provider\u2019s certified hosted components; the platform never touches raw cardholder data.'),
      ]),
    ],
    [28, 22, 50],
  ),
  pageBreak(),
];

// 5. Five-year support
const support = [
  h1('4. Five-year Priority support engagement'),
  p(
    'This section sets out the scope of the proposed five-year Priority support engagement. Commercial terms, service-credit percentages, and detailed schedules sit in the support contract itself; this section is the board-level summary of what the engagement provides and how it will be governed.',
  ),

  h2('4.1 Term and governance'),
  bullet('Term: five years from the agreed effective date.'),
  bullet(
    'Named account contact on each side, with documented escalation routes for service issues and contractual matters.',
  ),
  bullet(
    'Quarterly service review meeting between the vendor account team and the GFI nominated lead. Standard agenda: incidents and trends, planned change activity, security update, roadmap intelligence relevant to GFI, and review of any service credits or open actions.',
  ),
  bullet('Annual security review meeting, separately scheduled, to refresh this briefing.'),

  h2('4.2 Service hours'),
  p(
    'Standard support hours are 09:00 to 17:30 UK time (GMT/BST), Monday to Friday, excluding English public holidays. Severity-1 incidents declared outside these hours are handled in accordance with the response targets in the severity table below.',
  ),

  h2('4.3 Severity definitions and response targets'),
  table(
    [
      row([
        cell('Severity', { header: true, width: 18 }),
        cell('Description', { header: true, width: 42 }),
        cell('Response target', { header: true, width: 20 }),
        cell('Resolution target', { header: true, width: 20 }),
      ]),
      row([
        cell('Sev 1 — Critical'),
        cell('Service is down or unusable for all or substantially all users; or a security incident requiring immediate action.'),
        cell('Within 1 business hour'),
        cell('Continuous work until workaround or full restoration.'),
      ]),
      row([
        cell('Sev 2 — Major'),
        cell('A major function is impaired for a significant group of users, and no reasonable workaround is available.'),
        cell('Within 4 business hours'),
        cell('Target within 2 business days.'),
      ]),
      row([
        cell('Sev 3 — Minor'),
        cell('A minor function is impaired, or the issue affects a small number of users, and a workaround exists.'),
        cell('Within 1 business day'),
        cell('Target within 5 business days.'),
      ]),
      row([
        cell('Sev 4 — Request'),
        cell('Question, request for information, cosmetic issue, or small configuration request.'),
        cell('Within 2 business days'),
        cell('Scheduled into the next available release window.'),
      ]),
    ],
    [18, 42, 20, 20],
  ),

  h2('4.4 Channels'),
  bullet('Primary channel: the support ticketing portal, available 24/7 for raising incidents.'),
  bullet(
    'Secondary channel: a nominated support email address, monitored during service hours.',
  ),
  bullet(
    'Telephone: reserved for declared Sev 1 incidents and provided to GFI\u2019s named contacts at contract signature.',
  ),

  h2('4.5 Inclusions'),
  bullet('Diagnosis and resolution of defects in the platform.'),
  bullet('Security patches and routine security updates.'),
  bullet(
    'Maintenance of underlying platform dependencies, including the hosting and database platforms.',
  ),
  bullet(
    'Monitoring of the production environment, including alerting on availability and error-rate thresholds.',
  ),
  bullet('Periodic verification that backups can be restored.'),
  bullet(
    'Minor configuration changes — for example, branding updates, tenant settings, role adjustments, small copy edits — within a reasonable monthly effort allowance defined in the contract schedule.',
  ),
  bullet(
    'Training refreshers for new GFI administrators, with the annual volume to be confirmed in the contract schedule.',
  ),
  bullet('The annual security review meeting referenced above.'),

  h2('4.6 Change requests vs support'),
  p(
    'A clear distinction is maintained between covered support work and change requests. Covered support includes defect fixes, security and maintenance work, and the minor configuration changes listed above. Change requests are new features, new integrations, significant data model changes, or work that materially changes the behaviour of the platform for GFI.',
  ),
  p(
    'Light-touch change requests below an effort threshold agreed in the contract schedule are absorbed within the engagement. Larger change requests are scoped and quoted separately, with the option for GFI to approve or decline. This avoids both unbounded scope creep and small requests being held up by formal change control.',
  ),

  h2('4.7 Exclusions'),
  bullet(
    'Outages or degradations caused by third-party providers outside the vendor\u2019s control — for example, the payment, accounting, transactional email, meetings, and calendar providers.',
  ),
  bullet(
    'Issues caused by configuration changes made by GFI administrators within their permitted scope.',
  ),
  bullet('Misuse of the platform contrary to the acceptable use terms.'),
  bullet(
    'Bespoke new feature development beyond the change-request threshold described above.',
  ),
  bullet('The accuracy and lawfulness of content and personal data entered by GFI users.'),
  bullet(
    'Integration with systems that are not in the scope of the agreed integrations list.',
  ),

  h2('4.8 Service credits'),
  p(
    'Sustained breaches of the response or resolution targets above attract service credits, calculated and applied in accordance with the schedule to the support contract. Specific percentage values and caps are set in the contract and are not duplicated here. Service credits are GFI\u2019s sole financial remedy for service-level breaches that do not amount to a material breach of contract.',
  ),

  h2('4.9 GFI responsibilities'),
  bullet(
    'Nominate a small number of named administrators authorised to raise tickets and make configuration decisions.',
  ),
  bullet('Classify the severity of new tickets accurately at point of submission.'),
  bullet(
    'Provide timely access to test users, sample data, or example records where they are needed for diagnosis.',
  ),
  bullet(
    'Notify the vendor in advance of planned events likely to drive a material increase in load — for example, open days, intakes, fundraising appeals, or major communications.',
  ),
  bullet('Keep contact details for the named administrators up to date.'),

  h2('4.10 Continuity'),
  bullet(
    'Source code escrow is available as an option, releasable on defined trigger events such as vendor insolvency.',
  ),
  bullet(
    'Documented data export is available throughout the term, allowing GFI to extract its information in structured form.',
  ),
  bullet(
    'A defined off-boarding process applies at the end of the term, covering final data export, secure deletion of GFI data from vendor systems on a documented schedule, and transition support.',
  ),
  pageBreak(),
];

// 6. Risk summary
const risks = [
  h1('5. Risk summary'),
  p(
    'The table below summarises the principal risks the Board should be aware of in relation to the platform and the support engagement, together with the mitigations already in place. It is deliberately short and honest; it is not a comprehensive risk register.',
  ),
  table(
    [
      row([
        cell('Risk', { header: true, width: 28 }),
        cell('Likelihood', { header: true, width: 14 }),
        cell('Impact', { header: true, width: 14 }),
        cell('Mitigation in place', { header: true, width: 44 }),
      ]),
      row([
        cell('Outage of a third-party provider (payments, accounting, email, meetings)'),
        cell('Low–Medium'),
        cell('Medium'),
        cell('Operational fallbacks where feasible; clear status communication to GFI; providers themselves operate to enterprise SLAs; impact contained to the affected function rather than the whole service.'),
      ]),
      row([
        cell('Credential compromise of a GFI administrator'),
        cell('Low'),
        cell('High'),
        cell('SSO with corporate identity providers; enforced strong passwords and lockout; option to require two-factor authentication for administrative roles; full audit trail of administrative actions.'),
      ]),
      row([
        cell('Accidental data exposure by an internal GFI user'),
        cell('Low–Medium'),
        cell('Medium'),
        cell('Role-based and field-level permissions limit what each user can see and export; audit trail captures bulk operations; the vendor can assist GFI with role design and review.'),
      ]),
      row([
        cell('Key-person dependency at the vendor'),
        cell('Low'),
        cell('Medium'),
        cell('Documented runbooks and code review practice; multiple engineers familiar with GFI\u2019s tenant; source code escrow option; off-boarding process in place at end of term.'),
      ]),
      row([
        cell('Regulatory change (UK GDPR, ePrivacy)'),
        cell('Medium'),
        cell('Low–Medium'),
        cell('Vendor tracks relevant regulatory developments; changes affecting the data processing agreement are notified and re-papered with GFI as required.'),
      ]),
      row([
        cell('Loss of data due to operational error'),
        cell('Low'),
        cell('High'),
        cell('Daily backups with point-in-time recovery; staged deployment with rollback; documented and exercised restore procedure; production changes are peer-reviewed.'),
      ]),
    ],
    [28, 14, 14, 44],
  ),
  pageBreak(),
];

// 7. Conclusion
const conclusion = [
  h1('6. Conclusion and recommendation'),
  p(
    'The platform on which GFI operates is built on modern, well-understood security foundations: EU-resident hosting, encryption in transit and at rest, strong identity and access controls, strict logical separation between organisations, payment handling that keeps GFI at the lowest applicable PCI-DSS scope, monitored operations, and a documented incident response process. The platform is aligned to UK GDPR, ISO/IEC 27001, Cyber Essentials, SOC 2 Trust Services Criteria, and PCI-DSS SAQ-A, with the limits of that alignment stated honestly in this paper.',
  ),
  p(
    'The proposed five-year Priority support engagement gives GFI a stable, predictable basis on which to run the service: clear severity definitions and response targets, named contacts, quarterly service reviews, an annual security review, and a transparent boundary between included support and chargeable change.',
  ),
  p(
    [
      { text: 'The Board is invited to: ', bold: true },
      { text: '(i) note the information security posture summarised in this paper, and (ii) approve the five-year Priority support engagement on the terms set out in the accompanying support contract.' },
    ],
  ),
  pageBreak(),
];

// 8. Appendices
const appendices = [
  h1('Appendix A — Glossary'),
  table(
    [
      row([
        cell('Term', { header: true, width: 22 }),
        cell('Meaning', { header: true, width: 78 }),
      ]),
      row([cell('TLS'), cell('Transport Layer Security — the standard protocol that encrypts traffic between a web browser and a service.')]),
      row([cell('UK GDPR'), cell('The United Kingdom\u2019s implementation of the EU General Data Protection Regulation, alongside the Data Protection Act 2018.')]),
      row([cell('DPA'), cell('Data Processing Agreement — the written contract required under Article 28 UK GDPR when one party processes personal data on behalf of another.')]),
      row([cell('PCI-DSS'), cell('Payment Card Industry Data Security Standard — the security standard that applies to organisations that handle card data.')]),
      row([cell('SAQ-A'), cell('Self-Assessment Questionnaire A — the lowest PCI-DSS scope, applicable to merchants who fully outsource card handling to a certified provider.')]),
      row([cell('ISO/IEC 27001'), cell('International standard for information security management systems.')]),
      row([cell('SOC 2'), cell('Service Organisation Control 2 — an auditing framework covering security, availability, processing integrity, confidentiality, and privacy.')]),
      row([cell('Cyber Essentials'), cell('UK Government-backed scheme covering five foundational technical security controls.')]),
      row([cell('RPO'), cell('Recovery Point Objective — the maximum amount of recent data, measured in time, that may be lost in the event of a major incident.')]),
      row([cell('RTO'), cell('Recovery Time Objective — the maximum time within which the service should be restored after a major incident.')]),
      row([cell('SSO'), cell('Single Sign-On — using a corporate identity (such as Google Workspace or Microsoft 365) to sign in to multiple applications.')]),
      row([cell('SLA'), cell('Service Level Agreement — the committed targets for response and resolution.')]),
      row([cell('Sub-processor'), cell('A third party engaged by the vendor to assist in providing the service, which may process personal data on GFI\u2019s behalf.')]),
    ],
    [22, 78],
  ),

  pageBreak(),
  h1('Appendix B — Sub-processor categories'),
  p(
    'The platform relies on the following categories of sub-processor to deliver the service. The full list of named providers, the precise data categories they receive, and their hosting locations is maintained by the vendor and is available to GFI on request under NDA.',
  ),
  table(
    [
      row([
        cell('Category', { header: true, width: 26 }),
        cell('Purpose', { header: true, width: 50 }),
        cell('Hosting region', { header: true, width: 24 }),
      ]),
      row([cell('Application hosting'), cell('Runs the application and serves requests to GFI users.'), cell('EU')]),
      row([cell('Managed database'), cell('Stores GFI\u2019s data, performs backups, and supports point-in-time recovery.'), cell('EU (Frankfurt)')]),
      row([cell('Payments'), cell('Securely captures and processes card payments on GFI\u2019s behalf.'), cell('EU / global')]),
      row([cell('Accounting'), cell('Receives invoice and credit-note information for GFI\u2019s financial records.'), cell('EU / UK')]),
      row([cell('Transactional email'), cell('Delivers transactional and campaign emails to recipients.'), cell('EU')]),
      row([cell('Online meetings'), cell('Hosts virtual sessions and webinars associated with GFI events.'), cell('EU / global')]),
      row([cell('Calendar'), cell('Optional calendar synchronisation for events the user opts to share.'), cell('EU / global')]),
      row([cell('Identity providers'), cell('Single sign-on for staff and members where they choose to use it.'), cell('EU / global')]),
    ],
    [26, 50, 24],
  ),
  p(
    [
      {
        text: 'Note: ',
        bold: true,
      },
      {
        text: 'where a category shows hosting region as “EU / global”, the provider operates globally but GFI\u2019s data is hosted in EU regions in normal operation. The current data residency configuration is reviewed annually as part of the security review meeting.',
      },
    ],
  ),
];

const allChildren = [
  ...coverChildren,
  ...tocChildren,
  ...execSummary,
  ...platformOverview,
  ...security,
  ...support,
  ...risks,
  ...conclusion,
  ...appendices,
];

// First section: cover only (no header, no page number)
const coverSection = {
  properties: {
    page: {
      size: {
        orientation: PageOrientation.PORTRAIT,
        // A4
        width: 11906,
        height: 16838,
      },
      margin: {
        top: convertInchesToTwip(1),
        bottom: convertInchesToTwip(1),
        left: convertInchesToTwip(1),
        right: convertInchesToTwip(1),
      },
    },
    titlePage: true,
  },
  headers: {
    default: new Header({
      children: [
        new Paragraph({
          alignment: AlignmentType.RIGHT,
          children: [
            new TextRun({
              text: 'Confidential — Board Paper',
              size: SMALL_SIZE,
              color: MUTED,
              italics: true,
              font: FONT,
            }),
          ],
        }),
      ],
    }),
    first: new Header({ children: [new Paragraph({ children: [] })] }),
  },
  footers: {
    default: new Footer({
      children: [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [
            new TextRun({
              text: 'Graduate Futures Institute · Information Security and Long-Term Support · v1.0 · May 2026 · Page ',
              size: SMALL_SIZE,
              color: MUTED,
              font: FONT,
            }),
            new TextRun({ children: [PageNumber.CURRENT], size: SMALL_SIZE, color: MUTED, font: FONT }),
            new TextRun({ text: ' of ', size: SMALL_SIZE, color: MUTED, font: FONT }),
            new TextRun({ children: [PageNumber.TOTAL_PAGES], size: SMALL_SIZE, color: MUTED, font: FONT }),
          ],
        }),
      ],
    }),
    first: new Footer({ children: [new Paragraph({ children: [] })] }),
  },
  children: allChildren,
};

const doc = new Document({
  creator: 'Graduate Futures Institute — Board Paper',
  title: 'Information Security and Long-Term Support — Board Briefing',
  description: 'Board briefing for Graduate Futures Institute on platform security and the proposed five-year Priority support engagement.',
  styles: {
    default: {
      document: {
        run: { font: FONT, size: BODY_SIZE },
        paragraph: { spacing: { line: 300 } },
      },
      heading1: {
        run: { font: FONT, size: H1_SIZE, bold: true, color: BRAND },
        paragraph: { spacing: { before: 360, after: 180 } },
      },
      heading2: {
        run: { font: FONT, size: H2_SIZE, bold: true, color: BRAND },
        paragraph: { spacing: { before: 280, after: 140 } },
      },
      heading3: {
        run: { font: FONT, size: H3_SIZE, bold: true, color: '333333' },
        paragraph: { spacing: { before: 200, after: 100 } },
      },
    },
  },
  numbering: {
    config: [
      {
        reference: 'bullets',
        levels: [
          {
            level: 0,
            format: LevelFormat.BULLET,
            text: '\u2022',
            alignment: AlignmentType.LEFT,
            style: {
              paragraph: { indent: { left: 360, hanging: 200 } },
              run: { font: FONT, size: BODY_SIZE },
            },
          },
          {
            level: 1,
            format: LevelFormat.BULLET,
            text: '\u25E6',
            alignment: AlignmentType.LEFT,
            style: {
              paragraph: { indent: { left: 720, hanging: 200 } },
              run: { font: FONT, size: BODY_SIZE },
            },
          },
        ],
      },
    ],
  },
  features: { updateFields: true },
  sections: [coverSection],
});

const out = 'exports/GFI-Security-and-Support-Board-Paper-v1.0.docx';
mkdirSync(dirname(out), { recursive: true });
const buffer = await Packer.toBuffer(doc);
writeFileSync(out, buffer);
console.log('Wrote', out, buffer.length, 'bytes');
