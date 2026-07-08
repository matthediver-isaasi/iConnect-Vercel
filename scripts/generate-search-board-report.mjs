// One-off: generates the board-facing Word report on iConnect search behaviour,
// tuning options, and the Member AI assistant (Task: board report for BNMS).
// Output: reports/iConnect-Search-and-Member-AI-Board-Report.docx
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  ShadingType,
} from 'docx';
import { writeFileSync, mkdirSync } from 'fs';

const BRAND = '4B2E83'; // deep purple heading accent
const GREY = '595959';

const p = (text, opts = {}) =>
  new Paragraph({
    spacing: { after: 160, line: 300 },
    alignment: AlignmentType.JUSTIFIED,
    ...opts.para,
    children: [new TextRun({ text, size: 22, font: 'Calibri', ...opts.run })],
  });

const bullet = (text, opts = {}) =>
  new Paragraph({
    bullet: { level: 0 },
    spacing: { after: 80, line: 280 },
    children: [new TextRun({ text, size: 22, font: 'Calibri', ...opts.run })],
  });

const boldLead = (lead, rest) =>
  new Paragraph({
    bullet: { level: 0 },
    spacing: { after: 80, line: 280 },
    children: [
      new TextRun({ text: lead, bold: true, size: 22, font: 'Calibri' }),
      new TextRun({ text: rest, size: 22, font: 'Calibri' }),
    ],
  });

const h1 = (text) =>
  new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 360, after: 200 },
    children: [new TextRun({ text, size: 30, bold: true, color: BRAND, font: 'Calibri' })],
  });

const cellBorders = {
  top: { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' },
  bottom: { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' },
  left: { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' },
  right: { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' },
};

const headerCell = (text, width) =>
  new TableCell({
    width: { size: width, type: WidthType.PERCENTAGE },
    shading: { type: ShadingType.CLEAR, fill: BRAND },
    borders: cellBorders,
    margins: { top: 100, bottom: 100, left: 120, right: 120 },
    children: [
      new Paragraph({
        spacing: { after: 0 },
        children: [new TextRun({ text, bold: true, color: 'FFFFFF', size: 21, font: 'Calibri' })],
      }),
    ],
  });

const bodyCell = (text, width, { bold = false, fill } = {}) =>
  new TableCell({
    width: { size: width, type: WidthType.PERCENTAGE },
    ...(fill ? { shading: { type: ShadingType.CLEAR, fill } } : {}),
    borders: cellBorders,
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    children: [
      new Paragraph({
        spacing: { after: 0, line: 260 },
        children: [new TextRun({ text, size: 20, bold, font: 'Calibri' })],
      }),
    ],
  });

const optionsTable = new Table({
  width: { size: 100, type: WidthType.PERCENTAGE },
  rows: [
    new TableRow({
      tableHeader: true,
      children: [headerCell('Option', 26), headerCell('Benefit', 37), headerCell('Trade-off', 37)],
    }),
    new TableRow({
      children: [
        bodyCell('Boost title matches', 26, { bold: true }),
        bodyCell(
          'Items whose title contains the search word appear above items that only mention it in the body. "Join" would rank the Join page above content that merely references joining.',
          37
        ),
        bodyCell(
          'Very recent, highly relevant content can sit slightly lower if the keyword only appears in its body text.',
          37
        ),
      ],
    }),
    new TableRow({
      children: [
        bodyCell('Titles-and-page-names only', 26, { bold: true, fill: 'F5F2F9' }),
        bodyCell(
          'The simplest, most predictable behaviour: results only appear when the keyword is in a title or page name, so there is no deep-linking into the middle of documents or articles.',
          37,
          { fill: 'F5F2F9' }
        ),
        bodyCell(
          'Members lose the ability to discover content where the keyword appears only inside the body — a document about membership benefits that never uses the word "join" in its title would no longer be found.',
          37,
          { fill: 'F5F2F9' }
        ),
      ],
    }),
    new TableRow({
      children: [
        bodyCell('Content-type priority order', 26, { bold: true }),
        bodyCell(
          'Each organisation chooses the order in which types appear — for example Pages first, then Events, then Resources — so core site pages always lead.',
          37
        ),
        bodyCell(
          'A fixed order can push a genuinely better match (say, a highly relevant event) below a weaker page match.',
          37
        ),
      ],
    }),
    new TableRow({
      children: [
        bodyCell('Pinned results for key terms', 26, { bold: true, fill: 'F5F2F9' }),
        bodyCell(
          'Guaranteed outcomes for the searches that matter most: "Join" always shows the Join page first, regardless of anything else.',
          37,
          { fill: 'F5F2F9' }
        ),
        bodyCell(
          'Requires light curation — someone decides which terms are pinned and keeps the list current.',
          37,
          { fill: 'F5F2F9' }
        ),
      ],
    }),
    new TableRow({
      children: [
        bodyCell('Blended relevance ranking', 26, { bold: true }),
        bodyCell(
          'A balanced default: title matches and freshness are weighed together, so the Join page ranks highly for "Join" while new events and resources still surface for topical searches.',
          37
        ),
        bodyCell(
          'Ranking is less transparent than a simple rule — "why is this first?" has a more nuanced answer.',
          37
        ),
      ],
    }),
  ],
});

const doc = new Document({
  creator: 'iConnect',
  title: 'iConnect Search: How It Works, Tuning Options, and the Member AI Assistant',
  styles: {
    default: {
      document: { run: { font: 'Calibri', size: 22 } },
    },
  },
  sections: [
    {
      properties: {
        page: { margin: { top: 1200, bottom: 1200, left: 1300, right: 1300 } },
      },
      children: [
        // ---- Title block ----
        new Paragraph({
          spacing: { before: 1400, after: 120 },
          alignment: AlignmentType.CENTER,
          children: [
            new TextRun({ text: 'iConnect Platform', size: 26, color: GREY, font: 'Calibri' }),
          ],
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 200 },
          children: [
            new TextRun({
              text: 'Search: How It Works, Options for Tuning, and the Member AI Assistant',
              size: 44,
              bold: true,
              color: BRAND,
              font: 'Calibri',
            }),
          ],
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 60 },
          children: [
            new TextRun({ text: 'A briefing for the Board', size: 26, color: GREY, font: 'Calibri' }),
          ],
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 500 },
          children: [new TextRun({ text: 'July 2026', size: 24, color: GREY, font: 'Calibri' })],
        }),

        // ---- 1. Executive summary ----
        h1('1. Executive Summary'),
        p(
          'A question was raised about why searching for "Join" on the website showed resources and events above the Join page itself. This paper explains the behaviour: it is working as designed, not a fault. iConnect search deliberately looks inside the full content of every published item — not just titles — so members find relevant material even when the keyword never appears in a heading, and it orders results freshest-first so timely content such as upcoming events and newly added resources is easy to find. The Join page did match the search; it simply sat below dated items because undated site pages are ordered after dated content. That said, the observation is a fair one, and several practical options exist to tune search so that key pages such as "Join" appear where visitors expect them. This paper sets out those options, and also introduces the Member AI assistant — a conversational, next-generation way for members to find answers that understands what they mean rather than just the words they type.'
        ),

        // ---- 2. How search works today ----
        h1('2. How Search Works Today'),
        p(
          'When a member or visitor types a search, iConnect looks across six kinds of content in one pass: events, articles, news, resources, site pages, and multi-session events such as conferences. This breadth is a strength — a single search box covers the whole of the organisation\'s public presence.'
        ),
        p('Two design choices shape what appears, and in what order:'),
        boldLead(
          'Search reads the whole item, not just the title. ',
          'A match counts whether the keyword appears in the title, the summary, or anywhere in the page or document content. This is deliberate: it means a member searching for a topic finds the resource that covers it, even when the author never used that exact word in the title. It is the same principle major search engines use, and it is what makes content genuinely discoverable rather than dependent on perfect titling.'
        ),
        boldLead(
          'Results are ordered freshest-first. ',
          'Items that carry a date — events, news, articles, resources with release dates — are shown newest first, and dated items are shown above undated ones. For a membership organisation this is usually the right instinct: the things members most often search for are timely (an upcoming event, a recent announcement, a newly published resource), and this ordering surfaces them prominently.'
        ),
        p(
          'The "Join" example follows directly from these two choices. The Join page matched the search — it was found, and it appeared in the results. But the Join page is a standing site page with no date, while several resources and events also mention joining within their content and do carry dates. Under freshest-first ordering, those dated items were listed above the undated Join page. In other words: nothing failed, and nothing was missing — the ordering rule simply favoured timeliness over the static page. The next section sets out how that balance can be adjusted where an organisation would prefer a different emphasis.'
        ),

        // ---- 3. Options to adjust search ----
        h1('3. Options for Adjusting Search Behaviour'),
        p(
          'Search ranking is a set of dials, not a fixed law. The table below sets out the realistic options, each of which can be applied per organisation. They are not mutually exclusive — several combine well.'
        ),
        optionsTable,
        new Paragraph({ spacing: { after: 160 }, children: [] }),
        p(
          'For most organisations we would steer towards the last two: pinned results give certainty on the handful of searches that really matter, and blended relevance ranking quietly improves everything else. The titles-only mode is available for organisations that prefer maximum predictability and are comfortable trading away in-content discovery.'
        ),

        // ---- 4. Member AI ----
        h1('4. The Member AI Assistant: The Future of Finding Things'),
        p(
          'Keyword search — however well tuned — still asks the member to guess the right word. The Member AI assistant, already part of the iConnect platform, takes a fundamentally different approach: members ask questions in plain language, and the assistant answers them.'
        ),
        p('At a capability level, the assistant:'),
        boldLead(
          'Understands intent, not just keywords. ',
          '"How do I become a member?" finds the joining information even though the word "join" was never typed. Follow-up questions work naturally, as a conversation.'
        ),
        boldLead(
          'Answers from your live content, with citations. ',
          'Replies are grounded in the organisation\'s own published events, articles, news, and resources — and every answer comes with clickable links to the source items, so members can go straight to the page or document behind the answer.'
        ),
        boldLead(
          'Answers factual questions from live records. ',
          'Questions such as "how many events are running this year?" or "how many member organisations are based in Scotland?" are answered with real, current figures drawn directly from the organisation\'s records — not estimates.'
        ),
        boldLead(
          'Always respects each member\'s permissions. ',
          'The assistant only ever draws on content the asking member is entitled to see. Members-only material and group-restricted content are never exposed to someone outside that audience — the same access rules that govern the portal govern the assistant, without exception.'
        ),
        p(
          'The assistant complements the search box today and, for many members, will come to replace it: rather than scanning a results list, they simply get the answer with the sources attached. For a question like the one that prompted this paper, the assistant would respond to "how do I join?" with the joining information itself, linked directly to the Join page.'
        ),

        // ---- 5. Recommendation ----
        h1('5. Recommendation and Next Steps'),
        p('We suggest a modest, low-risk path:'),
        bullet(
          'Pilot a search adjustment for BNMS — either boosting title matches or applying a content-type priority order with site pages first — and review the results together against real searches such as "Join".'
        ),
        bullet(
          'Optionally pin the Join page for joining-related search terms, guaranteeing it appears first for the searches that matter most to recruitment.'
        ),
        bullet(
          'Arrange a short demonstration of the Member AI assistant, using BNMS\'s own content, so the board can see conversational answering and cited sources first-hand.'
        ),
        p(
          'The client\'s observation was well made, and it has a straightforward set of answers: today\'s behaviour is intentional and defensible, the tuning options are real and readily applied, and the platform\'s direction of travel — conversational, intent-aware answering — goes beyond what any keyword ranking can offer.'
        ),
      ],
    },
  ],
});

mkdirSync('reports', { recursive: true });
const buf = await Packer.toBuffer(doc);
writeFileSync('reports/iConnect-Search-and-Member-AI-Board-Report.docx', buf);
console.log('Written reports/iConnect-Search-and-Member-AI-Board-Report.docx', buf.length, 'bytes');
