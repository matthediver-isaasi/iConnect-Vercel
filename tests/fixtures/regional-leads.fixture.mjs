// Sanitized from the published Regional Leads Canvas response. Authored
// geometry, styles, card configuration and breakpoint bounds are retained;
// public copy, tenant identifiers, people and remote assets are not.
export const REGIONAL_SLUG = "regional-leads-browser-fixture";
export const REGIONAL_CARD_ID = "regional-member-group-cards";
export const REGIONAL_OWNER_ID = "regional-groups-section";
export const REGIONAL_FOLLOWING_ID = "regional-following-heading";
export const REGIONAL_TERMINAL_ID = "regional-stage-terminal";
export const REGIONAL_GROUP_IDS = Array.from(
  { length: 15 },
  (_, index) => `regional-group-${index + 1}`,
);

export const REGIONAL_GEOMETRY = {
  desktop: {
    viewport: { width: 1440, height: 1000 },
    owner: { x: 0, y: 1008, w: 1200, h: 2248, hidden: false },
    cards: { x: 0, y: 1248, w: 1192, h: 2296, hidden: false, manualWidth: true },
    following: { x: 0, y: 3624, w: 328, h: 65, hidden: false, manualWidth: true },
    terminal: { x: 0, y: 5107, w: 1200, h: 192 },
    stageHeight: 5299,
    columns: 3,
    effectiveFollowingGap: 368,
  },
  tablet: {
    viewport: { width: 768, height: 900 },
    owner: { x: 0, y: 1065, w: 768, h: 2526 },
    cards: { x: 0, y: 1339, w: 768, h: 2240 },
    following: { x: 24, y: 3639, w: 328, h: 65 },
    terminal: { x: 24, y: 4673, w: 720, h: 704 },
    stageHeight: 5377,
    columns: 2,
    effectiveFollowingGap: 60,
  },
  mobile: {
    viewport: { width: 375, height: 844 },
    owner: { x: 0, y: 1562, w: 375, h: 2651 },
    cards: { x: 0, y: 1960, w: 375, h: 6560 },
    following: { x: 16, y: 8548, w: 343, h: 59 },
    terminal: { x: 0, y: 10576, w: 375, h: 407 },
    stageHeight: 10983,
    columns: 1,
    effectiveFollowingGap: 28,
  },
};

const baseStyle = {
  zIndex: 1,
  opacity: 1,
  boxShadow: "none",
  background: "transparent",
  paddingTop: 0,
  borderColor: "#cbd5e1",
  borderStyle: "solid",
  borderWidth: 0,
  paddingLeft: 0,
  borderRadius: 4,
  paddingRight: 0,
  paddingBottom: 0,
};

function block(id, type, bp, content = {}, style = {}) {
  return {
    id,
    name: id,
    type,
    bp,
    style: { ...baseStyle, ...style },
    content,
    a11y: {
      role: "",
      altText: "",
      tabIndex: null,
      ariaLabel: "",
      ariaHidden: false,
    },
    locked: false,
    groupId: null,
    anchorId: "",
    fullWidth: type === "member-group-cards",
  };
}

const bp = (key) => Object.fromEntries(
  Object.entries(REGIONAL_GEOMETRY).map(([breakpoint, value]) => [breakpoint, value[key]]),
);

const sectionContent = { bgType: "color", fullBleed: true, bgImageUrl: "" };

export const regionalLeadsPage = {
  id: "regional-leads-fixture-page",
  title: "Regional cards browser fixture",
  slug: REGIONAL_SLUG,
  description: "",
  status: "published",
  layout_type: "public",
  tenant_id: "fixture-tenant",
  builder_type: "canvas",
  public_chrome: "both",
  canvas_design: {
    version: 1,
    root: {
      background: null,
      groups: [],
      guides: { vertical: [], horizontal: [] },
      sections: [{
        id: "root-section",
        children: [
          block("regional-intro-section", "section", {
            desktop: { x: 0, y: 0, w: 1200, h: 500, hidden: false, manualWidth: true },
            tablet: { x: 0, y: 40, w: 768, h: 319, hidden: false },
            mobile: { x: 0, y: 0, w: 375, h: 600 },
          }, { ...sectionContent, bgType: "color" }, { paddingTop: 24, paddingRight: 24, paddingBottom: 24, paddingLeft: 24 }),
          block("regional-intro-heading", "text", {
            desktop: { x: 0, y: 60, w: 568, h: 89, hidden: false, manualWidth: true },
            tablet: { x: 24, y: 80, w: 568, h: 89 },
            mobile: { x: 16, y: 72, w: 343, h: 67 },
          }, { html: "<p>Regional fixture</p>", headingAs: "1", lineHeight: 0.9 }),
          block(REGIONAL_OWNER_ID, "section", bp("owner"), sectionContent, {
            background: "#f9fafc",
            paddingTop: 24,
            paddingRight: 24,
            paddingBottom: 24,
            paddingLeft: 24,
          }),
          block("regional-list-heading", "text", {
            desktop: { x: 0, y: 1064, w: 368, h: 65, hidden: false, manualWidth: true },
            tablet: { x: 24, y: 1105, w: 368, h: 65 },
            mobile: { x: 16, y: 1594, w: 343, h: 59 },
          }, { html: "<p>Fixture directory</p>", headingAs: "2" }),
          block("regional-list-copy", "text", {
            desktop: { x: 0, y: 1129, w: 1200, h: 80, hidden: false, manualWidth: true },
            tablet: { x: 24, y: 1182, w: 720, h: 133 },
            mobile: { x: 16, y: 1665, w: 343, h: 272 },
          }, { html: "<p>Sanitized browser regression copy.</p>" }),
          block(REGIONAL_CARD_ID, "member-group-cards", bp("cards"), {
            limit: 6,
            source: "selected",
            columns: { mobile: 1, tablet: 2, desktop: 3 },
            selectedGroupIds: REGIONAL_GROUP_IDS,
            selectedGroupRoles: Object.fromEntries(
              REGIONAL_GROUP_IDS.map((id) => [id, "Fixture lead"]),
            ),
          }),
          block(REGIONAL_FOLLOWING_ID, "text", bp("following"), {
            html: "<p>Following fixture section</p>",
            headingAs: "2",
            bulletIcon: "fa-solid fa-circle-question",
          }),
          block("regional-following-copy", "text", {
            desktop: { x: 0, y: 3689, w: 525, h: 409, hidden: false },
            tablet: { x: 24, y: 3716, w: 348, h: 617 },
            mobile: { x: 16, y: 8619, w: 343, h: 580 },
          }, { html: "<p>Sanitized following-section content.</p>" }),
          block(REGIONAL_TERMINAL_ID, "section", {
            desktop: { x: 0, y: 5107, w: 1200, h: 192, hidden: false },
            tablet: { x: 24, y: 4673, w: 720, h: 704 },
            mobile: { x: 0, y: 10576, w: 375, h: 407 },
          }, sectionContent, { background: "#f1f8fe" }),
        ],
      }],
    },
  },
};

export const regionalGroups = REGIONAL_GROUP_IDS.map((id, index) => ({
  id,
  name: `Fixture region ${index + 1}`,
  description: `<p>Sanitized region ${index + 1}.</p>`,
  allow_self_join: index % 5 !== 4,
  is_active: true,
  default_self_join_role: "Member",
  header_image_url: `/regional-leads-fixture/image-${index + 1}.svg`,
}));