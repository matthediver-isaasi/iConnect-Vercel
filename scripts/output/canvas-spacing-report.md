# BNMS Canvas Pages — Spacing Drift Report (scan only)

_Generated 2026-07-04T10:58:49.102Z. **No database writes were made.** This is
a dry-run analysis of the older, hand-built CanvasBuilder pages against the
canonical spacing rhythm produced by `scripts/provision-canvas-page-from-doc.mjs`._

## Summary

| Metric | Count |
| --- | ---: |
| Total published canvas pages | 96 |
| Excluded — script-provisioned (29) | 29 |
| Excluded — reference/baseline (3) | 3 |
| Excluded — autumn meeting pages | 6 |
| Excluded — `-copy` duplicates | 1 |
| **In scope (analysed)** | **57** |
| → Straightforward to normalize | 19 |
| → Needs human review | 38 |

## Target rhythm (the "standard")

| Value | Target |
| --- | ---: |
| Canvas width | 1200 |
| Content left/right margin | 150 (content width 900) |
| Two-column width / gap | 420 / 60 |
| Opening / closing hero height | 600 / 420 |
| Hero horizontal padding | 200 (full-bleed) |
| Gap after hero | 48 |
| Colour band inner top / all-sides padding | 56 / 24 |
| Heading→divider / divider→body gap | 12 / 20 |
| Divider width / thickness | 300 (col 260) / 1 |
| Standard section gap | 56 |

### Baseline (reference pages, measured — do not modify)

> Note: the target-rhythm constants above (from the provisioning layout
> engine) are authoritative. Of the three named reference pages, only
> `about-mrt` sits cleanly on the 150/900 grid — `travelling-fellowships`
> and `honory-membership` are the original hand-built pages and carry their
> own minor drift (some blocks at x=0/125/616), which is why their measured
> content margin below reads as 0. They are analysed for context only and
> are not modified by any pass.

| Page | Content margin | Content width | Hero pad | Band pad | Common gaps |
| --- | ---: | ---: | ---: | ---: | --- |
| about-mrt | 152 | 900 | 200 | 24 | 12px×7, 20px×5, 56px×5, 16px×1, 48px×1 |
| honory-membership | 0 | 952 | 200 | 24 | 16px×3, 0px×2, 32px×1, 36px×1, 40px×1 |
| travelling-fellowships | 0 | 952 | 200 | 24 | 0px×2, 32px×2, 36px×2, 360px×2, -4px×2 |

## Straightforward to normalize (19)

These are single-column pages built only from standard blocks. A
normalization pass would re-align content margins, hero padding, band
padding, dividers and vertical gaps to the target with low risk.

### nuclear-medicine-technology-pathway

_Nuclear Medicine Technology Pathway_  · 30 blocks · block types: hero×2, text×13, image×6, divider×4, card×4, section×1

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | 124 | 150 |
| Content width | 952 | 900 |
| Content right margin | 124 | 150 |
| hero[0] height / padX / fullBleed | 600 / 150·150 / true | 600 / 200 / true |
| hero[1] height / padX / fullBleed | 400 / 100·100 / true | 420 / 200 / true |
| band[0] pad (T·R·B·L) / innerTop | 24·24·24·24 / 32 | 24 / 56 |
| divider widths / thickness | 560,560,560,560 / 1,1,1,1 | 300/260 / 1 |
| Vertical gaps (top 5) | 0px×5, 48px×4, 16px×2, 40px×2, 8px×1 | 56 between sections |

**Deltas beyond tolerance:** 12

- `contentLeftMargin`: 124 → 150 (Δ -26)
- `contentWidth`: 952 → 900 (Δ 52)
- `contentRightMargin`: 124 → 150 (Δ -26)
- `hero[0].padLeft`: 150 → 200 (Δ -50)
- `hero[0].padRight`: 150 → 200 (Δ -50)
- `hero[1].padLeft`: 100 → 200 (Δ -100)
- `hero[1].padRight`: 100 → 200 (Δ -100)
- `band[0].innerTop`: 32 → 56 (Δ -24)
- `divider[0].width`: 560 → 300 (Δ 260)
- `divider[1].width`: 560 → 300 (Δ 260)
- `divider[2].width`: 560 → 300 (Δ 260)
- `divider[3].width`: 560 → 300 (Δ 260)

**Proposed safe geometry changes (dry-run):** 20 field edits · **proposed y-reflow shifts:** 27

- block `block-mqskl8rn-eii577` (h2): y 784 → 840
- block `block-mqskl8rn-d7dajv` (body): y 880 → 932
- block `block-mqukyjz2-6kmzgc` (divider): y 1184 → 1284
- block `block-mqukx591-c3cxdp` (image): y 1256 → 1328
- block `block-mqukx591-4qdbxl` (h2): y 1392 → 1520
- block `block-mqukzsza-1pbpdg` (card): y 1520 → 1656
- block `block-mqukzsza-jtl9g8` (card): y 1520 → 1656
- block `block-mqukzsza-hxn4jw` (card): y 1520 → 1656

---

### corporate-support

_Corporate Support _  · 35 blocks · block types: hero×2, text×18, section×1, image×8, divider×6

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | 124 | 150 |
| Content width | 952 | 900 |
| Content right margin | 124 | 150 |
| hero[0] height / padX / fullBleed | 600 / 200·200 / true | 600 / 200 / true |
| hero[1] height / padX / fullBleed | 400 / 200·200 / true | 420 / 200 / true |
| band[0] pad (T·R·B·L) / innerTop | 24·24·24·24 / 128 | 24 / 56 |
| divider widths / thickness | 560,560,560,560,560,560 / 1,1,1,1,1,1 | 300/260 / 1 |
| Vertical gaps (top 5) | 16px×4, 0px×3, 8px×3, 36px×3, -4px×3 | 56 between sections |

**Deltas beyond tolerance:** 10

- `contentLeftMargin`: 124 → 150 (Δ -26)
- `contentWidth`: 952 → 900 (Δ 52)
- `contentRightMargin`: 124 → 150 (Δ -26)
- `band[0].innerTop`: 128 → 56 (Δ 72)
- `divider[0].width`: 560 → 300 (Δ 260)
- `divider[1].width`: 560 → 300 (Δ 260)
- `divider[2].width`: 560 → 300 (Δ 260)
- `divider[3].width`: 560 → 300 (Δ 260)
- `divider[4].width`: 560 → 300 (Δ 260)
- `divider[5].width`: 560 → 300 (Δ 260)

**Proposed safe geometry changes (dry-run):** 14 field edits · **proposed y-reflow shifts:** 31

- block `block-mqskl8rn-eii577` (h2): y 784 → 840
- block `block-mqskl8rn-d7dajv` (body): y 880 → 932
- block `block-mqtpkzwy-rs66wg` (image): y 1384 → 1420
- block `block-mqtq3twa-iyijkd` (image): y 1384 → 1420
- block `block-mqtocu5g-ha3i0k` (h3): y 1444 → 1540
- block `block-mqtocu5g-t9sdey` (h3): y 1444 → 1540
- block `block-mqtpy4bh-8aqqye` (divider): y 1476 → 1608
- block `block-mqtpywzr-ne4zp3` (divider): y 1476 → 1608

---

### ros-breen-fund

_The Ros Breen Fund_  · 25 blocks · block types: hero×2, text×13, section×1, image×5, divider×4

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | 0 | 150 |
| Content width | 952 | 900 |
| Content right margin | 252 | 150 |
| hero[0] height / padX / fullBleed | 600 / 200·200 / true | 600 / 200 / true |
| hero[1] height / padX / fullBleed | 400 / 180·180 / true | 420 / 200 / true |
| band[0] pad (T·R·B·L) / innerTop | 24·24·24·24 / 32 | 24 / 56 |
| divider widths / thickness | 560,560,560,560 / 1,1,1,1 | 300/260 / 1 |
| Vertical gaps (top 5) | 0px×2, 36px×2, 48px×2, -4px×2, -24px×2 | 56 between sections |

**Deltas beyond tolerance:** 10

- `contentLeftMargin`: 0 → 150 (Δ -150)
- `contentWidth`: 952 → 900 (Δ 52)
- `contentRightMargin`: 252 → 150 (Δ 102)
- `hero[1].padLeft`: 180 → 200 (Δ -20)
- `hero[1].padRight`: 180 → 200 (Δ -20)
- `band[0].innerTop`: 32 → 56 (Δ -24)
- `divider[0].width`: 560 → 300 (Δ 260)
- `divider[1].width`: 560 → 300 (Δ 260)
- `divider[2].width`: 560 → 300 (Δ 260)
- `divider[3].width`: 560 → 300 (Δ 260)

**Proposed safe geometry changes (dry-run):** 12 field edits · **proposed y-reflow shifts:** 22

- block `block-mqskl8rn-eii577` (h2): y 784 → 840
- block `block-mqskl8rn-d7dajv` (body): y 880 → 932
- block `block-mquhi8jr-efafpx` (h2): y 1312 → 1356
- block `block-mqtpkzwy-rs66wg` (image): y 1392 → 1492
- block `block-mquhnisw-6oa0uj` (image): y 1392 → 1492
- block `block-mqtocu5g-ha3i0k` (h3): y 1452 → 1612
- block `block-mquhnisw-cbbgqg` (h3): y 1452 → 1612
- block `block-mqtpy4bh-8aqqye` (divider): y 1484 → 1680

---

### supporting-the-future

_Supporting the future_  · 52 blocks · block types: hero×1, text×27, section×2, image×11, divider×7, card×2, button×2

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | 124 | 150 |
| Content width | 952 | 900 |
| Content right margin | 124 | 150 |
| hero[0] height / padX / fullBleed | 600 / 200·200 / true | 600 / 200 / true |
| band[0] pad (T·R·B·L) / innerTop | 24·24·24·24 / 40 | 24 / 56 |
| band[1] pad (T·R·B·L) / innerTop | 24·24·24·24 / 40 | 24 / 56 |
| divider widths / thickness | 560,560,560,560,560,560,560 / 1,1,1,1,1,1,1 | 300/260 / 1 |
| Vertical gaps (top 5) | 0px×5, 16px×5, 20px×4, 24px×2, 96px×2 | 56 between sections |

**Deltas beyond tolerance:** 10

- `contentLeftMargin`: 124 → 150 (Δ -26)
- `contentWidth`: 952 → 900 (Δ 52)
- `contentRightMargin`: 124 → 150 (Δ -26)
- `divider[0].width`: 560 → 300 (Δ 260)
- `divider[1].width`: 560 → 300 (Δ 260)
- `divider[2].width`: 560 → 300 (Δ 260)
- `divider[3].width`: 560 → 300 (Δ 260)
- `divider[4].width`: 560 → 300 (Δ 260)
- `divider[5].width`: 560 → 300 (Δ 260)
- `divider[6].width`: 560 → 300 (Δ 260)

**Proposed safe geometry changes (dry-run):** 28 field edits · **proposed y-reflow shifts:** 48

- block `block-mqskl8rn-eii577` (h2): y 784 → 840
- block `block-mqskl8rn-d7dajv` (body): y 880 → 932
- block `block-mqts6dif-qwnakx` (image): y 1180 → 1284
- block `block-mqts6dif-11tbky` (h2): y 1316 → 1476
- block `block-mqts6dif-om5u82` (body): y 1416 → 1568
- block `block-mqts8mnx-9l1ea8` (h2): y 1760 → 1872
- block `block-mqtq3twa-iyijkd` (image): y 1856 → 2008
- block `block-mqtpkzwy-rs66wg` (image): y 1864 → 2008

---

### what-does-a-nuclear-medicine-technologist-do

_What does a nuclear medicine technologist do_  · 18 blocks · block types: hero×2, text×7, image×3, card×3, divider×2, section×1

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | 0 | 150 |
| Content width | 952 | 900 |
| Content right margin | 144 | 150 |
| hero[0] height / padX / fullBleed | 600 / 150·150 / true | 600 / 200 / true |
| hero[1] height / padX / fullBleed | 600 / 70·70 / true | 420 / 200 / true |
| band[0] pad (T·R·B·L) / innerTop | 24·24·24·24 / 32 | 24 / 56 |
| divider widths / thickness | 560,560 / 1,1 | 300/260 / 1 |
| Vertical gaps (top 5) | 0px×3, 24px×2, 16px×1, 32px×1, 36px×1 | 56 between sections |

**Deltas beyond tolerance:** 10

- `contentLeftMargin`: 0 → 150 (Δ -150)
- `contentWidth`: 952 → 900 (Δ 52)
- `hero[0].padLeft`: 150 → 200 (Δ -50)
- `hero[0].padRight`: 150 → 200 (Δ -50)
- `hero[1].padLeft`: 70 → 200 (Δ -130)
- `hero[1].padRight`: 70 → 200 (Δ -130)
- `hero[1].height`: 600 → 420 (Δ 180)
- `band[0].innerTop`: 32 → 56 (Δ -24)
- `divider[0].width`: 560 → 300 (Δ 260)
- `divider[1].width`: 560 → 300 (Δ 260)

**Proposed safe geometry changes (dry-run):** 16 field edits · **proposed y-reflow shifts:** 15

- block `block-mqskl8rn-eii577` (h2): y 784 → 840
- block `block-mqskl8rn-d7dajv` (body): y 880 → 932
- block `block-mqukayl8-iq33ds` (divider): y 1368 → 1444
- block `block-mquka6jy-kf0o7q` (image): y 1416 → 1488
- block `block-mquka6jy-tztfav` (h2): y 1552 → 1680
- block `block-mquk8pxe-6zxh4k` (card): y 1656 → 1816
- block `block-mquk97ra-tb4o0o` (card): y 1656 → 1816
- block `block-mquk9a0f-jq8sem` (card): y 1656 → 1816

---

### celebration-announcements

_Celebration-annoucements_  · 26 blocks · block types: section×4, text×14, image×6, button×1, hero×1

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | 424 | 150 |
| Content width | 608 | 900 |
| Content right margin | 168 | 150 |
| hero[0] height / padX / fullBleed | 600 / 200·200 / true | 600 / 200 / true |
| band[0] pad (T·R·B·L) / innerTop | 24·24·24·24 / 152 | 24 / 56 |
| band[1] pad (T·R·B·L) / innerTop | 24·24·24·24 / 48 | 24 / 56 |
| band[2] pad (T·R·B·L) / innerTop | 24·24·24·24 / 40 | 24 / 56 |
| band[3] pad (T·R·B·L) / innerTop | 0·0·0·0 / 32 | 24 / 56 |
| Vertical gaps (top 5) | 48px×1, 56px×1, 64px×1, 80px×1, 96px×1 | 56 between sections |

**Deltas beyond tolerance:** 9

- `contentLeftMargin`: 424 → 150 (Δ 274)
- `contentWidth`: 608 → 900 (Δ -292)
- `contentRightMargin`: 168 → 150 (Δ 18)
- `band[0].innerTop`: 152 → 56 (Δ 96)
- `band[3].padTop`: 0 → 24 (Δ -24)
- `band[3].padRight`: 0 → 24 (Δ -24)
- `band[3].padBottom`: 0 → 24 (Δ -24)
- `band[3].padLeft`: 0 → 24 (Δ -24)
- `band[3].innerTop`: 32 → 56 (Δ -24)

**Proposed safe geometry changes (dry-run):** 36 field edits · **proposed y-reflow shifts:** 19

- block `block-mpfr72fp-txvgiw` (body): y 784 → 1094
- block `block-mqnwhj6g-nat0b3` (image): y 1136 → 1366
- block `block-mqnwhj6g-r5v98f` (h2): y 1136 → 1366
- block `block-mqnwhj6g-epso9m` (body): y 1216 → 1838
- block `block-mqnwi6lm-e5wv5p` (image): y 1648 → 2222
- block `block-mqnwi6lm-sxwdqu` (h2): y 1648 → 2222
- block `block-mqnwi6lm-7uqmj4` (body): y 1712 → 2662
- block `block-mqp5uyzd-xvujto` (image): y 2168 → 3110

---

### general-fund

_General fund_  · 44 blocks · block types: hero×2, text×23, section×2, card×3, image×8, divider×6

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | 0 | 150 |
| Content width | 952 | 900 |
| Content right margin | 152 | 150 |
| hero[0] height / padX / fullBleed | 600 / 200·200 / true | 600 / 200 / true |
| hero[1] height / padX / fullBleed | 400 / 200·200 / true | 420 / 200 / true |
| band[0] pad (T·R·B·L) / innerTop | 24·24·24·24 / 48 | 24 / 56 |
| band[1] pad (T·R·B·L) / innerTop | 24·24·24·24 / 8 | 24 / 56 |
| divider widths / thickness | 560,560,560,560,560,560 / 1,1,1,1,1,1 | 300/260 / 1 |
| Vertical gaps (top 5) | 16px×5, -4px×3, 0px×2, 32px×2, 88px×2 | 56 between sections |

**Deltas beyond tolerance:** 9

- `contentLeftMargin`: 0 → 150 (Δ -150)
- `contentWidth`: 952 → 900 (Δ 52)
- `band[1].innerTop`: 8 → 56 (Δ -48)
- `divider[0].width`: 560 → 300 (Δ 260)
- `divider[1].width`: 560 → 300 (Δ 260)
- `divider[2].width`: 560 → 300 (Δ 260)
- `divider[3].width`: 560 → 300 (Δ 260)
- `divider[4].width`: 560 → 300 (Δ 260)
- `divider[5].width`: 560 → 300 (Δ 260)

**Proposed safe geometry changes (dry-run):** 15 field edits · **proposed y-reflow shifts:** 41

- block `block-mqtpcuim-fxt83i` (image): y 632 → 648
- block `block-mqskl8rn-eii577` (h2): y 768 → 840
- block `block-mqskl8rn-d7dajv` (body): y 864 → 932
- block `block-mqtqmdpa-rysv13` (h2): y 1248 → 1284
- block `block-mqtpkzwy-rs66wg` (image): y 1344 → 1420
- block `block-mqtq3twa-iyijkd` (image): y 1344 → 1420
- block `block-mqtocu5g-ha3i0k` (h3): y 1404 → 1540
- block `block-mqtocu5g-t9sdey` (h3): y 1404 → 1540

---

### share-your-experience

_Share your experience_  · 22 blocks · block types: hero×2, text×11, section×1, image×5, divider×3

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | 124 | 150 |
| Content width | 952 | 900 |
| Content right margin | 124 | 150 |
| hero[0] height / padX / fullBleed | 600 / 200·200 / true | 600 / 200 / true |
| hero[1] height / padX / fullBleed | 450 / 100·100 / true | 420 / 200 / true |
| band[0] pad (T·R·B·L) / innerTop | 24·24·24·24 / 16 | 24 / 56 |
| divider widths / thickness | 560,560,560 / 1,1,1 | 300/260 / 1 |
| Vertical gaps (top 5) | 0px×2, 16px×2, 36px×2, 48px×2, -4px×2 | 56 between sections |

**Deltas beyond tolerance:** 9

- `contentLeftMargin`: 124 → 150 (Δ -26)
- `contentWidth`: 952 → 900 (Δ 52)
- `contentRightMargin`: 124 → 150 (Δ -26)
- `hero[1].padLeft`: 100 → 200 (Δ -100)
- `hero[1].padRight`: 100 → 200 (Δ -100)
- `band[0].innerTop`: 16 → 56 (Δ -40)
- `divider[0].width`: 560 → 300 (Δ 260)
- `divider[1].width`: 560 → 300 (Δ 260)
- `divider[2].width`: 560 → 300 (Δ 260)

**Proposed safe geometry changes (dry-run):** 10 field edits · **proposed y-reflow shifts:** 19

- block `block-mqskl8rn-eii577` (h2): y 784 → 840
- block `block-mqskl8rn-d7dajv` (body): y 880 → 932
- block `block-mqtpkzwy-rs66wg` (image): y 1216 → 1284
- block `block-mqtq3twa-iyijkd` (image): y 1216 → 1284
- block `block-mqtocu5g-ha3i0k` (h3): y 1276 → 1404
- block `block-mqtocu5g-t9sdey` (h3): y 1276 → 1404
- block `block-mqtpy4bh-8aqqye` (divider): y 1308 → 1472
- block `block-mqtpywzr-ne4zp3` (divider): y 1308 → 1472

---

### mentorship

_Mentorship_  · 21 blocks · block types: hero×2, text×8, section×1, image×4, divider×2, button×2, card×2

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | 124 | 150 |
| Content width | 952 | 900 |
| Content right margin | 124 | 150 |
| hero[0] height / padX / fullBleed | 600 / 200·200 / true | 600 / 200 / true |
| hero[1] height / padX / fullBleed | 600 / 200·200 / true | 420 / 200 / true |
| band[0] pad (T·R·B·L) / innerTop | 24·24·24·24 / 16 | 24 / 56 |
| divider widths / thickness | 560,560 / 1,1 | 300/260 / 1 |
| Vertical gaps (top 5) | 0px×2, 48px×2, 16px×1, 36px×1, 40px×1 | 56 between sections |

**Deltas beyond tolerance:** 7

- `contentLeftMargin`: 124 → 150 (Δ -26)
- `contentWidth`: 952 → 900 (Δ 52)
- `contentRightMargin`: 124 → 150 (Δ -26)
- `hero[1].height`: 600 → 420 (Δ 180)
- `band[0].innerTop`: 16 → 56 (Δ -40)
- `divider[0].width`: 560 → 300 (Δ 260)
- `divider[1].width`: 560 → 300 (Δ 260)

**Proposed safe geometry changes (dry-run):** 8 field edits · **proposed y-reflow shifts:** 18

- block `block-mqskl8rn-eii577` (h2): y 784 → 840
- block `block-mqskl8rn-d7dajv` (body): y 880 → 932
- block `block-mqtpkzwy-rs66wg` (image): y 1296 → 1356
- block `block-mqtq3twa-iyijkd` (image): y 1296 → 1356
- block `block-mqtocu5g-ha3i0k` (h3): y 1356 → 1476
- block `block-mqtocu5g-t9sdey` (h3): y 1356 → 1476
- block `block-mqtpy4bh-8aqqye` (divider): y 1388 → 1544
- block `block-mqtpywzr-ne4zp3` (divider): y 1388 → 1544

---

### stay-connected

_Stay connected_  · 21 blocks · block types: hero×2, text×9, section×1, image×3, divider×4, card×2

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | 0 | 150 |
| Content width | 952 | 900 |
| Content right margin | 148 | 150 |
| hero[0] height / padX / fullBleed | 600 / 200·200 / true | 600 / 200 / true |
| hero[1] height / padX / fullBleed | 400 / 200·200 / true | 420 / 200 / true |
| band[0] pad (T·R·B·L) / innerTop | 24·24·24·24 / 32 | 24 / 56 |
| divider widths / thickness | 560,560,560,560 / 1,1,1,1 | 300/260 / 1 |
| Vertical gaps (top 5) | 16px×3, 36px×2, 0px×1, 48px×1, 52px×1 | 56 between sections |

**Deltas beyond tolerance:** 7

- `contentLeftMargin`: 0 → 150 (Δ -150)
- `contentWidth`: 952 → 900 (Δ 52)
- `band[0].innerTop`: 32 → 56 (Δ -24)
- `divider[0].width`: 560 → 300 (Δ 260)
- `divider[1].width`: 560 → 300 (Δ 260)
- `divider[2].width`: 560 → 300 (Δ 260)
- `divider[3].width`: 560 → 300 (Δ 260)

**Proposed safe geometry changes (dry-run):** 8 field edits · **proposed y-reflow shifts:** 17

- block `block-mqskl8rn-eii577` (h2): y 784 → 840
- block `block-mqskl8rn-d7dajv` (body): y 880 → 932
- block `block-mqtxbz2e-cwz3fg` (card): y 1124 → 1196
- block `block-mqtxbz2e-sz88np` (card): y 1124 → 1196
- block `block-mqtxiix5-9hm8au` (divider): y 1576 → 1652
- block `block-mqtpkzwy-rs66wg` (image): y 1784 → 1832
- block `block-mqtq3twa-iyijkd` (image): y 1784 → 1832
- block `block-mqtocu5g-ha3i0k` (h3): y 1844 → 1952

---

### volunteering

_Volunteering_  · 29 blocks · block types: hero×2, text×11, image×5, card×4, section×1, divider×3, button×3

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | 124 | 150 |
| Content width | 952 | 900 |
| Content right margin | 124 | 150 |
| hero[0] height / padX / fullBleed | 600 / 200·200 / true | 600 / 200 / true |
| hero[1] height / padX / fullBleed | 400 / 200·200 / true | 420 / 200 / true |
| band[0] pad (T·R·B·L) / innerTop | 24·24·24·24 / 32 | 24 / 56 |
| divider widths / thickness | 560,560,560 / 1,1,1 | 300/260 / 1 |
| Vertical gaps (top 5) | 0px×3, 48px×2, 8px×1, 16px×1, 24px×1 | 56 between sections |

**Deltas beyond tolerance:** 7

- `contentLeftMargin`: 124 → 150 (Δ -26)
- `contentWidth`: 952 → 900 (Δ 52)
- `contentRightMargin`: 124 → 150 (Δ -26)
- `band[0].innerTop`: 32 → 56 (Δ -24)
- `divider[0].width`: 560 → 300 (Δ 260)
- `divider[1].width`: 560 → 300 (Δ 260)
- `divider[2].width`: 560 → 300 (Δ 260)

**Proposed safe geometry changes (dry-run):** 8 field edits · **proposed y-reflow shifts:** 26

- block `block-mqskl8rn-eii577` (h2): y 784 → 840
- block `block-mqskl8rn-d7dajv` (body): y 880 → 932
- block `block-mqun8goc-um46rt` (image): y 1224 → 1284
- block `block-mqun8goc-frrqno` (h2): y 1360 → 1476
- block `block-mqun99yj-riu8j7` (card): y 1480 → 1612
- block `block-mqun99yk-y2qxkc` (card): y 1480 → 1612
- block `block-mqun99yk-vethmx` (card): y 1480 → 1612
- block `block-mqun99yk-vhdypx` (card): y 1480 → 1612

---

### history-of-nuclear-medicine

_History of Nuclear Medicine_  · 17 blocks · block types: hero×1, section×1, text×10, image×5

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | 456 | 150 |
| Content width | 744 | 900 |
| Content right margin | 0 | 150 |
| hero[0] height / padX / fullBleed | 336 / 0·0 / true | 600 / 200 / true |
| band[0] pad (T·R·B·L) / innerTop | 24·24·24·24 / 40 | 24 / 56 |
| Vertical gaps (top 5) | 40px×3, 8px×2, 32px×2, 24px×1, 56px×1 | 56 between sections |

**Deltas beyond tolerance:** 6

- `contentLeftMargin`: 456 → 150 (Δ 306)
- `contentWidth`: 744 → 900 (Δ -156)
- `contentRightMargin`: 0 → 150 (Δ -150)
- `hero[0].padLeft`: 0 → 200 (Δ -200)
- `hero[0].padRight`: 0 → 200 (Δ -200)
- `hero[0].height`: 336 → 600 (Δ -264)

**Proposed safe geometry changes (dry-run):** 22 field edits · **proposed y-reflow shifts:** 11

- block `block-mqpkf0kz-g6a09w` (body): y 648 → 624
- block `block-mqpktani-mggcbi` (image): y 3248 → 3224
- block `block-mqpkqw80-82by9y` (body): y 3248 → 3224
- block `block-mqpkyyb1-k4h3h1` (image): y 5000 → 5048
- block `block-mqpl162f-3bbqef` (body): y 5392 → 5440
- block `block-mqpl162f-x7d8se` (image): y 5400 → 5440
- block `block-mqpl3tbl-f40ju0` (body): y 5768 → 5824
- block `block-mqpl6mbk-48f73f` (image): y 6464 → 6552

---

### patient-videos

_Patient Videos_  · 19 blocks · block types: hero×2, text×9, section×1, image×4, divider×2, button×1

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | 124 | 150 |
| Content width | 952 | 900 |
| Content right margin | 124 | 150 |
| hero[0] height / padX / fullBleed | 600 / 200·200 / true | 600 / 200 / true |
| hero[1] height / padX / fullBleed | 450 / 200·200 / true | 420 / 200 / true |
| band[0] pad (T·R·B·L) / innerTop | 24·24·24·24 / 16 | 24 / 56 |
| divider widths / thickness | 560,560 / 1,1 | 300/260 / 1 |
| Vertical gaps (top 5) | 16px×3, 0px×2, 36px×1, 40px×1, 48px×1 | 56 between sections |

**Deltas beyond tolerance:** 6

- `contentLeftMargin`: 124 → 150 (Δ -26)
- `contentWidth`: 952 → 900 (Δ 52)
- `contentRightMargin`: 124 → 150 (Δ -26)
- `band[0].innerTop`: 16 → 56 (Δ -40)
- `divider[0].width`: 560 → 300 (Δ 260)
- `divider[1].width`: 560 → 300 (Δ 260)

**Proposed safe geometry changes (dry-run):** 8 field edits · **proposed y-reflow shifts:** 16

- block `block-mqskl8rn-eii577` (h2): y 784 → 840
- block `block-mqskl8rn-d7dajv` (body): y 880 → 932
- block `block-mqtpkzwy-rs66wg` (image): y 1216 → 1284
- block `block-mqtq3twa-iyijkd` (image): y 1216 → 1284
- block `block-mqtocu5g-ha3i0k` (h3): y 1276 → 1404
- block `block-mqtocu5g-t9sdey` (h3): y 1276 → 1404
- block `block-mqtpy4bh-8aqqye` (divider): y 1308 → 1472
- block `block-mqtpywzr-ne4zp3` (divider): y 1308 → 1472

---

### jobs-board

_Jobs Board_  · 25 blocks · block types: hero×2, text×11, section×1, card×3, image×4, divider×2, button×2

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | 124 | 150 |
| Content width | 952 | 900 |
| Content right margin | 124 | 150 |
| hero[0] height / padX / fullBleed | 600 / 200·200 / true | 600 / 200 / true |
| hero[1] height / padX / fullBleed | 400 / 200·200 / true | 420 / 200 / true |
| band[0] pad (T·R·B·L) / innerTop | 24·24·24·24 / 44 | 24 / 56 |
| divider widths / thickness | 560,560 / 1,1 | 300/260 / 1 |
| Vertical gaps (top 5) | 16px×2, 40px×2, 0px×1, 24px×1, 28px×1 | 56 between sections |

**Deltas beyond tolerance:** 5

- `contentLeftMargin`: 124 → 150 (Δ -26)
- `contentWidth`: 952 → 900 (Δ 52)
- `contentRightMargin`: 124 → 150 (Δ -26)
- `divider[0].width`: 560 → 300 (Δ 260)
- `divider[1].width`: 560 → 300 (Δ 260)

**Proposed safe geometry changes (dry-run):** 14 field edits · **proposed y-reflow shifts:** 21

- block `block-mqskl8rn-eii577` (h2): y 784 → 840
- block `block-mqskl8rn-d7dajv` (body): y 880 → 932
- block `block-mqtpkzwy-rs66wg` (image): y 1336 → 1364
- block `block-mqtq3twa-iyijkd` (image): y 1336 → 1364
- block `block-mqtocu5g-ha3i0k` (h3): y 1396 → 1484
- block `block-mqtocu5g-t9sdey` (h3): y 1396 → 1484
- block `block-mqtpy4bh-8aqqye` (divider): y 1428 → 1552
- block `block-mqtpywzr-ne4zp3` (divider): y 1428 → 1552

---

### claim-tax-relief

_Claim tax relief_  · 21 blocks · block types: hero×1, text×10, section×1, card×3, image×4, divider×2

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | 152 | 150 |
| Content width | 952 | 900 |
| Content right margin | 152 | 150 |
| hero[0] height / padX / fullBleed | 600 / 200·200 / true | 600 / 200 / true |
| band[0] pad (T·R·B·L) / innerTop | 24·24·24·24 / 16 | 24 / 56 |
| divider widths / thickness | 560,560 / 1,1 | 300/260 / 1 |
| Vertical gaps (top 5) | 0px×2, 16px×2, 36px×1, 40px×1, 48px×1 | 56 between sections |

**Deltas beyond tolerance:** 4

- `contentWidth`: 952 → 900 (Δ 52)
- `band[0].innerTop`: 16 → 56 (Δ -40)
- `divider[0].width`: 560 → 300 (Δ 260)
- `divider[1].width`: 560 → 300 (Δ 260)

**Proposed safe geometry changes (dry-run):** 10 field edits · **proposed y-reflow shifts:** 18

- block `block-mqskl8rn-eii577` (h2): y 784 → 840
- block `block-mqskl8rn-d7dajv` (body): y 880 → 932
- block `block-mqtpkzwy-rs66wg` (image): y 1216 → 1284
- block `block-mqtq3twa-iyijkd` (image): y 1216 → 1284
- block `block-mqtocu5g-ha3i0k` (h3): y 1276 → 1404
- block `block-mqtocu5g-t9sdey` (h3): y 1276 → 1404
- block `block-mqtpy4bh-8aqqye` (divider): y 1308 → 1472
- block `block-mqtpywzr-ne4zp3` (divider): y 1308 → 1472

---

### patient-resources

_Patient Resources_  · 18 blocks · block types: hero×2, text×9, section×1, image×4, divider×2

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | 152 | 150 |
| Content width | 900 | 900 |
| Content right margin | 152 | 150 |
| hero[0] height / padX / fullBleed | 600 / 200·200 / true | 600 / 200 / true |
| hero[1] height / padX / fullBleed | 450 / 200·200 / true | 420 / 200 / true |
| band[0] pad (T·R·B·L) / innerTop | 24·24·24·24 / 16 | 24 / 56 |
| divider widths / thickness | 560,560 / 1,1 | 300/260 / 1 |
| Vertical gaps (top 5) | 0px×2, 16px×2, -24px×2, 36px×1, 48px×1 | 56 between sections |

**Deltas beyond tolerance:** 3

- `band[0].innerTop`: 16 → 56 (Δ -40)
- `divider[0].width`: 560 → 300 (Δ 260)
- `divider[1].width`: 560 → 300 (Δ 260)

**Proposed safe geometry changes (dry-run):** 8 field edits · **proposed y-reflow shifts:** 15

- block `block-mqskl8rn-eii577` (h2): y 784 → 840
- block `block-mqskl8rn-d7dajv` (body): y 880 → 932
- block `block-mqtpkzwy-rs66wg` (image): y 1248 → 1284
- block `block-mqtq3twa-iyijkd` (image): y 1248 → 1284
- block `block-mqtocu5g-ha3i0k` (h3): y 1308 → 1404
- block `block-mqtocu5g-t9sdey` (h3): y 1308 → 1404
- block `block-mqtpy4bh-8aqqye` (divider): y 1340 → 1472
- block `block-mqtpywzr-ne4zp3` (divider): y 1340 → 1472

---

### preparing-for-your-appointment

_Preparing for your appointment_  · 12 blocks · block types: hero×2, text×5, image×1, accordion×2, spacer×2

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | 152 | 150 |
| Content width | 952 | 900 |
| Content right margin | 124 | 150 |
| hero[0] height / padX / fullBleed | 600 / 200·200 / true | 600 / 200 / true |
| hero[1] height / padX / fullBleed | 600 / 200·200 / true | 420 / 200 / true |
| Vertical gaps (top 5) | 16px×2, 32px×2, 0px×1, 48px×1, 256px×1 | 56 between sections |

**Deltas beyond tolerance:** 3

- `contentWidth`: 952 → 900 (Δ 52)
- `contentRightMargin`: 124 → 150 (Δ -26)
- `hero[1].height`: 600 → 420 (Δ 180)

**Proposed safe geometry changes (dry-run):** 11 field edits · **proposed y-reflow shifts:** 10

- block `block-mqskl8rn-eii577` (h2): y 784 → 840
- block `block-mqskl8rn-d7dajv` (body): y 880 → 932
- block `block-mqv71o6e-pdwalp` (h2): y 1208 → 1284
- block `block-mqv70qwi-por599` (accordion): y 1320 → 1420
- block `block-mqv7al1k-hw17dz` (h2): y 1784 → 2692
- block `block-mqv7al1k-3bdm3m` (body): y 1880 → 2784
- block `block-mr4rtwdy-cfw6ic` (other): y 2608 → 3312
- block `block-mr4ruiyg-7dhats` (other): y 2616 → 3312

---

### professional-groups

_Professional Groups_  · 20 blocks · block types: hero×2, text×6, image×4, card×8

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | 124 | 150 |
| Content width | 952 | 900 |
| Content right margin | 124 | 150 |
| hero[0] height / padX / fullBleed | 600 / 200·200 / true | 600 / 200 / true |
| hero[1] height / padX / fullBleed | 400 / 200·200 / true | 420 / 200 / true |
| Vertical gaps (top 5) | 0px×4, 16px×2, 32px×2, 28px×1, 40px×1 | 56 between sections |

**Deltas beyond tolerance:** 3

- `contentLeftMargin`: 124 → 150 (Δ -26)
- `contentWidth`: 952 → 900 (Δ 52)
- `contentRightMargin`: 124 → 150 (Δ -26)

**Proposed safe geometry changes (dry-run):** 12 field edits · **proposed y-reflow shifts:** 18

- block `block-mqskl8rn-eii577` (h2): y 784 → 840
- block `block-mqskl8rn-d7dajv` (body): y 880 → 932
- block `block-mquvmnnn-9wzx1p` (image): y 1360 → 1396
- block `block-mquvhfu1-o4bq33` (h2): y 1496 → 1588
- block `block-mquvocxb-uwddmg` (card): y 1608 → 1724
- block `block-mquvp9pd-d3hkpb` (card): y 1608 → 1724
- block `block-mquvp6my-8e95p0` (card): y 1608 → 1724
- block `block-mquvqr18-4rv7fz` (card): y 2136 → 2280

---

### patients-and-carers

_Patients and Carers_  · 11 blocks · block types: hero×2, text×2, image×1, card×6

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | 152 | 150 |
| Content width | 904 | 900 |
| Content right margin | 144 | 150 |
| hero[0] height / padX / fullBleed | 600 / 200·200 / true | 600 / 200 / true |
| hero[1] height / padX / fullBleed | 450 / 200·200 / true | 420 / 200 / true |
| Vertical gaps (top 5) | 0px×1, 16px×1, 24px×1, 48px×1, 56px×1 | 56 between sections |

**Deltas beyond tolerance:** 0

**Proposed safe geometry changes (dry-run):** 4 field edits · **proposed y-reflow shifts:** 9

- block `block-mqskl8rn-eii577` (h2): y 784 → 840
- block `block-mqskl8rn-d7dajv` (body): y 880 → 932
- block `block-mqv6jy5o-ahnpuu` (card): y 1392 → 1436
- block `block-mqv6jy5o-57k9uu` (card): y 1392 → 1436
- block `block-mqv6jy5o-ngjs6z` (card): y 1392 → 1436
- block `block-mqv6jy5o-1mz65f` (card): y 1816 → 1892
- block `block-mqv6rviw-fcjc1v` (card): y 1816 → 1892
- block `block-mqv6rys7-mlw887` (card): y 1816 → 1892

---

## Needs human review (38)

These pages contain custom/dynamic blocks, event/meeting layouts, unusual
geometry, or are possible superseded duplicates. Spacing changes here could
disturb bespoke layouts — review before applying.

### membership-faqs

_Membership FAQs_  · 83 blocks · block types: hero×2, text×49, image×5, card×4, section×2, divider×21

**Flags:** heavy page (83 blocks)

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | 124 | 150 |
| Content width | 952 | 900 |
| Content right margin | 124 | 150 |
| hero[0] height / padX / fullBleed | 600 / 200·200 / true | 600 / 200 / true |
| hero[1] height / padX / fullBleed | 400 / 200·200 / true | 420 / 200 / true |
| band[0] pad (T·R·B·L) / innerTop | 24·24·24·24 / 24 | 24 / 56 |
| band[1] pad (T·R·B·L) / innerTop | 24·24·24·24 / 8 | 24 / 56 |
| divider widths / thickness | 560,560,560,560,560,560,560,560,560,560,560,560,560,560,560,560,560,560,560,560,560 / 1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1 | 300/260 / 1 |
| Vertical gaps (top 5) | -24px×9, 16px×4, -8px×4, -28px×4, 8px×3 | 56 between sections |

**Deltas beyond tolerance:** 26

- `contentLeftMargin`: 124 → 150 (Δ -26)
- `contentWidth`: 952 → 900 (Δ 52)
- `contentRightMargin`: 124 → 150 (Δ -26)
- `band[0].innerTop`: 24 → 56 (Δ -32)
- `band[1].innerTop`: 8 → 56 (Δ -48)
- `divider[0].width`: 560 → 300 (Δ 260)
- `divider[1].width`: 560 → 300 (Δ 260)
- `divider[2].width`: 560 → 300 (Δ 260)
- `divider[3].width`: 560 → 300 (Δ 260)
- `divider[4].width`: 560 → 300 (Δ 260)
- `divider[5].width`: 560 → 300 (Δ 260)
- `divider[6].width`: 560 → 300 (Δ 260)
- `divider[7].width`: 560 → 300 (Δ 260)
- `divider[8].width`: 560 → 300 (Δ 260)
- `divider[9].width`: 560 → 300 (Δ 260)
- `divider[10].width`: 560 → 300 (Δ 260)
- `divider[11].width`: 560 → 300 (Δ 260)
- `divider[12].width`: 560 → 300 (Δ 260)
- `divider[13].width`: 560 → 300 (Δ 260)
- `divider[14].width`: 560 → 300 (Δ 260)
- …and 6 more

**Proposed safe geometry changes (dry-run):** 14 field edits · **proposed y-reflow shifts:** 79

- block `block-mqskl8rn-eii577` (h2): y 784 → 840
- block `block-mquigtg5-uuzkt0` (card): y 888 → 976
- block `block-mquigtg5-fs015f` (card): y 888 → 976
- block `block-mquili8c-tzpqtw` (card): y 888 → 976
- block `block-mquili8c-uc7rd4` (card): y 888 → 976
- block `block-mquiv6ml-tgq6v1` (image): y 1384 → 1412
- block `block-mquism36-yc9qrp` (h2): y 1504 → 1596
- block `block-mquism36-ze3nlx` (h3): y 1624 → 1732

---

### member-benefits

_Member Benefits_  · 82 blocks · block types: hero×2, text×34, section×2, image×14, divider×12, card×8, button×10

**Flags:** heavy page (82 blocks)

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | 0 | 150 |
| Content width | 952 | 900 |
| Content right margin | 124 | 150 |
| hero[0] height / padX / fullBleed | 600 / 200·200 / true | 600 / 200 / true |
| hero[1] height / padX / fullBleed | 400 / 200·200 / true | 420 / 200 / true |
| band[0] pad (T·R·B·L) / innerTop | 24·24·24·24 / 25 | 24 / 56 |
| band[1] pad (T·R·B·L) / innerTop | 24·24·24·24 / 41 | 24 / 56 |
| divider widths / thickness | 560,560,560,560,560,560,560,560,560,560,560,560 / 1,1,1,1,1,1,1,1,1,1,1,1 | 300/260 / 1 |
| Vertical gaps (top 5) | -24px×6, 36px×5, -4px×4, 0px×3, 16px×3 | 56 between sections |

**Deltas beyond tolerance:** 16

- `contentLeftMargin`: 0 → 150 (Δ -150)
- `contentWidth`: 952 → 900 (Δ 52)
- `contentRightMargin`: 124 → 150 (Δ -26)
- `band[0].innerTop`: 25 → 56 (Δ -31)
- `divider[0].width`: 560 → 300 (Δ 260)
- `divider[1].width`: 560 → 300 (Δ 260)
- `divider[2].width`: 560 → 300 (Δ 260)
- `divider[3].width`: 560 → 300 (Δ 260)
- `divider[4].width`: 560 → 300 (Δ 260)
- `divider[5].width`: 560 → 300 (Δ 260)
- `divider[6].width`: 560 → 300 (Δ 260)
- `divider[7].width`: 560 → 300 (Δ 260)
- `divider[8].width`: 560 → 300 (Δ 260)
- `divider[9].width`: 560 → 300 (Δ 260)
- `divider[10].width`: 560 → 300 (Δ 260)
- `divider[11].width`: 560 → 300 (Δ 260)

**Proposed safe geometry changes (dry-run):** 28 field edits · **proposed y-reflow shifts:** 78

- block `block-mqskl8rn-eii577` (h2): y 784 → 840
- block `block-mqskl8rn-d7dajv` (body): y 880 → 932
- block `block-mqtu8g7t-dm5npy` (divider): y 1164 → 1236
- block `block-mqtu84pv-mupb1d` (image): y 1200 → 1280
- block `block-mqtu84pv-amjlyu` (h2): y 1336 → 1472
- block `block-mqtua594-fpc9ko` (card): y 1448 → 1608
- block `block-mqtua594-zizbws` (card): y 1448 → 1608
- block `block-mqtua594-dcn90k` (card): y 1976 → 2168

---

### newhome

_New Home_  · 18 blocks · block types: section×3, text×6, button×3, event-carousel×1, image×1, stat×3, article-list×1

**Flags:** custom/dynamic blocks: event-carousel, stat, article-list; no hero block (atypical layout)

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | 0 | 150 |
| Content width | 608 | 900 |
| Content right margin | 592 | 150 |
| band[0] pad (T·R·B·L) / innerTop | 0·0·0·0 / 104 | 24 / 56 |
| band[1] pad (T·R·B·L) / innerTop | 0·0·0·0 / 72 | 24 / 56 |
| band[2] pad (T·R·B·L) / innerTop | 0·0·0·0 / 64 | 24 / 56 |
| Vertical gaps (top 5) | 8px×2, 32px×2, 40px×1, 128px×1, 136px×1 | 56 between sections |

**Deltas beyond tolerance:** 16

- `contentLeftMargin`: 0 → 150 (Δ -150)
- `contentWidth`: 608 → 900 (Δ -292)
- `contentRightMargin`: 592 → 150 (Δ 442)
- `band[0].padTop`: 0 → 24 (Δ -24)
- `band[0].padRight`: 0 → 24 (Δ -24)
- `band[0].padBottom`: 0 → 24 (Δ -24)
- `band[0].padLeft`: 0 → 24 (Δ -24)
- `band[0].innerTop`: 104 → 56 (Δ 48)
- `band[1].padTop`: 0 → 24 (Δ -24)
- `band[1].padRight`: 0 → 24 (Δ -24)
- `band[1].padBottom`: 0 → 24 (Δ -24)
- `band[1].padLeft`: 0 → 24 (Δ -24)
- `band[2].padTop`: 0 → 24 (Δ -24)
- `band[2].padRight`: 0 → 24 (Δ -24)
- `band[2].padBottom`: 0 → 24 (Δ -24)
- `band[2].padLeft`: 0 → 24 (Δ -24)

**Proposed safe geometry changes (dry-run):** 22 field edits · **proposed y-reflow shifts:** 15

- block `block-mpb9zsc4-kupj3f` (body): y 104 → 0
- block `block-mpe54m64-m3e16p` (body): y 296 → 216
- block `block-mpe55njp-tmxh7v` (button): y 456 → 392
- block `block-mpe6lsrh-2w6wsj` (button): y 456 → 392
- block `block-mpe6mg2v-ezfw1e` (button): y 456 → 392
- block `block-mp6xw98d-m0kg0h` (other): y 696 → 496
- block `block-mpfr6g8n-v9rpql` (h2): y 1208 → 928
- block `block-mpfr5390-2iqrbo` (image): y 1208 → 928

---

### tor-professional-standards-committee

_TOR Professional Standards Committee_  · 5 blocks · block types: section×2, text×3

**Flags:** possible superseded duplicate of "professional-standards-committee"; no hero block (atypical layout)

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | 160 | 150 |
| Content width | 856 | 900 |
| Content right margin | 184 | 150 |
| band[0] pad (T·R·B·L) / innerTop | 0·0·0·0 / 120 | 24 / 56 |
| band[1] pad (T·R·B·L) / innerTop | 0·0·0·0 / 32 | 24 / 56 |
| Vertical gaps (top 5) | 24px×1, 136px×1 | 56 between sections |

**Deltas beyond tolerance:** 13

- `contentLeftMargin`: 160 → 150 (Δ 10)
- `contentWidth`: 856 → 900 (Δ -44)
- `contentRightMargin`: 184 → 150 (Δ 34)
- `band[0].padTop`: 0 → 24 (Δ -24)
- `band[0].padRight`: 0 → 24 (Δ -24)
- `band[0].padBottom`: 0 → 24 (Δ -24)
- `band[0].padLeft`: 0 → 24 (Δ -24)
- `band[0].innerTop`: 120 → 56 (Δ 64)
- `band[1].padTop`: 0 → 24 (Δ -24)
- `band[1].padRight`: 0 → 24 (Δ -24)
- `band[1].padBottom`: 0 → 24 (Δ -24)
- `band[1].padLeft`: 0 → 24 (Δ -24)
- `band[1].innerTop`: 32 → 56 (Δ -24)

**Proposed safe geometry changes (dry-run):** 14 field edits · **proposed y-reflow shifts:** 3

- block `block-mpb9zsc4-kupj3f` (body): y 120 → 0
- block `block-mpe54m64-m3e16p` (body): y 232 → 144
- block `block-mpfr72fp-txvgiw` (body): y 528 → 360

---

### medical-trainee-commitee

_Medical Trainee Commitee_  · 7 blocks · block types: section×1, text×3, divider×2, wall-of-fame×1

**Flags:** custom/dynamic blocks: wall-of-fame; possible superseded duplicate of "bnms-medical-training-committee"; no hero block (atypical layout)

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | 96 | 150 |
| Content width | 1008 | 900 |
| Content right margin | 96 | 150 |
| band[0] pad (T·R·B·L) / innerTop | 0·0·0·0 / — | 24 / 56 |
| divider widths / thickness | 1200,1200 / 3,3 | 300/260 / 1 |
| Vertical gaps (top 5) | 8px×1, 32px×1, 40px×1, 48px×1, -8px×1 | 56 between sections |

**Deltas beyond tolerance:** 11

- `contentLeftMargin`: 96 → 150 (Δ -54)
- `contentWidth`: 1008 → 900 (Δ 108)
- `contentRightMargin`: 96 → 150 (Δ -54)
- `band[0].padTop`: 0 → 24 (Δ -24)
- `band[0].padRight`: 0 → 24 (Δ -24)
- `band[0].padBottom`: 0 → 24 (Δ -24)
- `band[0].padLeft`: 0 → 24 (Δ -24)
- `divider[0].width`: 1200 → 300 (Δ 900)
- `divider[0].thickness`: 3 → 1 (Δ 2)
- `divider[1].width`: 1200 → 300 (Δ 900)
- `divider[1].thickness`: 3 → 1 (Δ 2)

**Proposed safe geometry changes (dry-run):** 16 field edits · **proposed y-reflow shifts:** 6

- block `block-mqphkf75-32jftu` (body): y 160 → 0
- block `block-mqpivguf-xe6n61` (divider): y 528 → 416
- block `block-mqpjbtlr-vmruqw` (body): y 592 → 460
- block `block-mqpiyxdx-unf1nc` (divider): y 928 → 860
- block `block-mqpjdemy-ksr8v3` (body): y 1000 → 904
- block `block-mqpjgh04-m0f3cc` (other): y 1272 → 1200

---

### nuclear-medicine-communications-journal

_Nuclear Medicine Communications Journal_  · 11 blocks · block types: section×2, text×6, button×1, image×1, accordion×1

**Flags:** no hero block (atypical layout)

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | 148 | 150 |
| Content width | 856 | 900 |
| Content right margin | 196 | 150 |
| band[0] pad (T·R·B·L) / innerTop | 0·0·0·0 / 56 | 24 / 56 |
| band[1] pad (T·R·B·L) / innerTop | 0·0·0·0 / 40 | 24 / 56 |
| Vertical gaps (top 5) | 16px×1, 32px×1, 40px×1, 104px×1, -344px×1 | 56 between sections |

**Deltas beyond tolerance:** 10

- `contentWidth`: 856 → 900 (Δ -44)
- `contentRightMargin`: 196 → 150 (Δ 46)
- `band[0].padTop`: 0 → 24 (Δ -24)
- `band[0].padRight`: 0 → 24 (Δ -24)
- `band[0].padBottom`: 0 → 24 (Δ -24)
- `band[0].padLeft`: 0 → 24 (Δ -24)
- `band[1].padTop`: 0 → 24 (Δ -24)
- `band[1].padRight`: 0 → 24 (Δ -24)
- `band[1].padBottom`: 0 → 24 (Δ -24)
- `band[1].padLeft`: 0 → 24 (Δ -24)

**Proposed safe geometry changes (dry-run):** 16 field edits · **proposed y-reflow shifts:** 8

- block `block-mpb9zsc4-kupj3f` (body): y 56 → 0
- block `block-mpe54m64-m3e16p` (body): y 232 → 216
- block `block-mpfr6g8n-v9rpql` (h2): y 536 → 496
- block `block-mpgtco33-hlw4t8` (image): y 544 → 496
- block `block-mpfr72fp-txvgiw` (body): y 616 → 924
- block `block-mpmpu7k8-w5rkkb` (body): y 944 → 1812
- block `block-mpmq1rke-1icx5x` (body): y 976 → 1908
- block `block-mpmprl85-21gxy4` (accordion): y 1200 → 2148

---

### obituaries

_Obituaries_  · 31 blocks · block types: section×6, text×21, image×3, card-flip-grid×1

**Flags:** custom/dynamic blocks: card-flip-grid; no hero block (atypical layout)

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | 0 | 150 |
| Content width | 608 | 900 |
| Content right margin | 592 | 150 |
| band[0] pad (T·R·B·L) / innerTop | 0·0·0·0 / 56 | 24 / 56 |
| band[1] pad (T·R·B·L) / innerTop | 24·24·24·24 / 40 | 24 / 56 |
| band[2] pad (T·R·B·L) / innerTop | 24·24·24·24 / 48 | 24 / 56 |
| band[3] pad (T·R·B·L) / innerTop | 24·24·24·24 / 32 | 24 / 56 |
| band[4] pad (T·R·B·L) / innerTop | 24·24·24·24 / 32 | 24 / 56 |
| band[5] pad (T·R·B·L) / innerTop | 24·24·24·24 / 32 | 24 / 56 |
| Vertical gaps (top 5) | 16px×3, 24px×3, 56px×2, 12px×1, 60px×1 | 56 between sections |

**Deltas beyond tolerance:** 10

- `contentLeftMargin`: 0 → 150 (Δ -150)
- `contentWidth`: 608 → 900 (Δ -292)
- `contentRightMargin`: 592 → 150 (Δ 442)
- `band[0].padTop`: 0 → 24 (Δ -24)
- `band[0].padRight`: 0 → 24 (Δ -24)
- `band[0].padBottom`: 0 → 24 (Δ -24)
- `band[0].padLeft`: 0 → 24 (Δ -24)
- `band[3].innerTop`: 32 → 56 (Δ -24)
- `band[4].innerTop`: 32 → 56 (Δ -24)
- `band[5].innerTop`: 32 → 56 (Δ -24)

**Proposed safe geometry changes (dry-run):** 48 field edits · **proposed y-reflow shifts:** 25

- block `block-mpb9zsc4-kupj3f` (body): y 56 → 0
- block `block-mpfr6g8n-v9rpql` (h2): y 256 → 144
- block `block-mpgtco33-hlw4t8` (image): y 256 → 144
- block `block-mpfr72fp-txvgiw` (body): y 336 → 596
- block `block-mqnwhj6g-nat0b3` (image): y 776 → 724
- block `block-mqnwhj6g-r5v98f` (h2): y 776 → 724
- block `block-mqnwhj6g-epso9m` (body): y 848 → 1220
- block `block-mqpbkreu-tlyrn7` (body): y 1252 → 1668

---

### scientific-and-education-committee

_Scientific & Education Commitee_  · 4 blocks · block types: section×1, divider×1, text×1, wall-of-fame×1

**Flags:** custom/dynamic blocks: wall-of-fame; possible superseded duplicate of "scientific-education-committee"; no hero block (atypical layout)

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | 96 | 150 |
| Content width | 1008 | 900 |
| Content right margin | 96 | 150 |
| band[0] pad (T·R·B·L) / innerTop | 0·0·0·0 / — | 24 / 56 |
| divider widths / thickness | 1200 / 3 | 300/260 / 1 |
| Vertical gaps (top 5) | 8px×1, -2548px×1 | 56 between sections |

**Deltas beyond tolerance:** 9

- `contentLeftMargin`: 96 → 150 (Δ -54)
- `contentWidth`: 1008 → 900 (Δ 108)
- `contentRightMargin`: 96 → 150 (Δ -54)
- `band[0].padTop`: 0 → 24 (Δ -24)
- `band[0].padRight`: 0 → 24 (Δ -24)
- `band[0].padBottom`: 0 → 24 (Δ -24)
- `band[0].padLeft`: 0 → 24 (Δ -24)
- `divider[0].width`: 1200 → 300 (Δ 900)
- `divider[0].thickness`: 3 → 1 (Δ 2)

**Proposed safe geometry changes (dry-run):** 11 field edits · **proposed y-reflow shifts:** 3

- block `block-mqpjdemy-ksr8v3` (body): y 160 → 0
- block `block-mqpjgh04-m0f3cc` (other): y 680 → 568
- block `block-mqpiyxdx-unf1nc` (divider): y 1260 → 3752

---

### what-does-a-radiopharmaceutical-scientist-do

_What does a Radiopharmaceutical Scientist do?_  · 42 blocks · block types: hero×2, text×20, image×9, symbol×1, card×3, section×1, divider×6

**Flags:** custom/dynamic blocks: symbol

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | 124 | 150 |
| Content width | 952 | 900 |
| Content right margin | 124 | 150 |
| hero[0] height / padX / fullBleed | 600 / 200·200 / true | 600 / 200 / true |
| hero[1] height / padX / fullBleed | 420 / 200·200 / true | 420 / 200 / true |
| band[0] pad (T·R·B·L) / innerTop | 24·24·24·24 / 43 | 24 / 56 |
| divider widths / thickness | 560,560,560,560,560,560 / 1,1,1,1,1,1 | 300/260 / 1 |
| Vertical gaps (top 5) | 0px×4, 16px×3, 32px×3, 36px×3, -4px×3 | 56 between sections |

**Deltas beyond tolerance:** 9

- `contentLeftMargin`: 124 → 150 (Δ -26)
- `contentWidth`: 952 → 900 (Δ 52)
- `contentRightMargin`: 124 → 150 (Δ -26)
- `divider[0].width`: 560 → 300 (Δ 260)
- `divider[1].width`: 560 → 300 (Δ 260)
- `divider[2].width`: 560 → 300 (Δ 260)
- `divider[3].width`: 560 → 300 (Δ 260)
- `divider[4].width`: 560 → 300 (Δ 260)
- `divider[5].width`: 560 → 300 (Δ 260)

**Proposed safe geometry changes (dry-run):** 16 field edits · **proposed y-reflow shifts:** 39

- block `block-mqskl8rn-eii577` (h2): y 784 → 840
- block `block-mqskl8rn-d7dajv` (body): y 880 → 932
- block `block-mquqp7sg-mwf9qh` (other): y 1296 → 1364
- block `block-mquqoz8s-l66e5y` (image): y 1376 → 1660
- block `block-mquqoz8s-qp2sqs` (h2): y 1512 → 1852
- block `block-mquqrzb6-dml1xq` (card): y 1624 → 1988
- block `block-mquqrzb6-kfumdo` (card): y 1624 → 1988
- block `block-mquqrzb6-992fti` (card): y 1624 → 1988

---

### career-resources

_Career Resources_  · 34 blocks · block types: hero×2, text×13, image×7, symbol×1, card×8, section×1, divider×2

**Flags:** custom/dynamic blocks: symbol

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | 124 | 150 |
| Content width | 952 | 900 |
| Content right margin | 124 | 150 |
| hero[0] height / padX / fullBleed | 600 / 200·200 / true | 600 / 200 / true |
| hero[1] height / padX / fullBleed | 400 / 100·100 / true | 420 / 200 / true |
| band[0] pad (T·R·B·L) / innerTop | 24·24·24·24 / 32 | 24 / 56 |
| divider widths / thickness | 560,560 / 1,1 | 300/260 / 1 |
| Vertical gaps (top 5) | 0px×6, 16px×2, 24px×2, 32px×2, 36px×1 | 56 between sections |

**Deltas beyond tolerance:** 8

- `contentLeftMargin`: 124 → 150 (Δ -26)
- `contentWidth`: 952 → 900 (Δ 52)
- `contentRightMargin`: 124 → 150 (Δ -26)
- `hero[1].padLeft`: 100 → 200 (Δ -100)
- `hero[1].padRight`: 100 → 200 (Δ -100)
- `band[0].innerTop`: 32 → 56 (Δ -24)
- `divider[0].width`: 560 → 300 (Δ 260)
- `divider[1].width`: 560 → 300 (Δ 260)

**Proposed safe geometry changes (dry-run):** 20 field edits · **proposed y-reflow shifts:** 31

- block `block-mqskl8rn-eii577` (h2): y 784 → 840
- block `block-mqskl8rn-d7dajv` (body): y 880 → 932
- block `block-mquwuwdz-6qq7mp` (other): y 1160 → 1244
- block `block-mquwuf94-droxai` (image): y 1232 → 1540
- block `block-mquwuf94-f4h4br` (h2): y 1368 → 1732
- block `block-mquwvp0h-9qqq4m` (card): y 1488 → 1868
- block `block-mquwvp0h-uzbvij` (card): y 1488 → 1868
- block `block-mquwvp0h-924cmf` (card): y 1488 → 1868

---

### declaration-of-interest

_Declaration of interest_  · 5 blocks · block types: section×2, text×2, form-embed×1

**Flags:** custom/dynamic blocks: form-embed; possible superseded duplicate of "declaration-of-interests"; no hero block (atypical layout)

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | 172 | 150 |
| Content width | 856 | 900 |
| Content right margin | 172 | 150 |
| band[0] pad (T·R·B·L) / innerTop | 0·0·0·0 / 88 | 24 / 56 |
| band[1] pad (T·R·B·L) / innerTop | 24·24·24·24 / 72 | 24 / 56 |
| Vertical gaps (top 5) | 64px×1, 160px×1 | 56 between sections |

**Deltas beyond tolerance:** 8

- `contentLeftMargin`: 172 → 150 (Δ 22)
- `contentWidth`: 856 → 900 (Δ -44)
- `contentRightMargin`: 172 → 150 (Δ 22)
- `band[0].padTop`: 0 → 24 (Δ -24)
- `band[0].padRight`: 0 → 24 (Δ -24)
- `band[0].padBottom`: 0 → 24 (Δ -24)
- `band[0].padLeft`: 0 → 24 (Δ -24)
- `band[0].innerTop`: 88 → 56 (Δ 32)

**Proposed safe geometry changes (dry-run):** 12 field edits · **proposed y-reflow shifts:** 3

- block `block-mpb9zsc4-kupj3f` (body): y 88 → 0
- block `block-mpfr72fp-txvgiw` (body): y 568 → 376
- block `block-mqp7eugc-1yljw7` (other): y 1056 → 856

---

### declaration-of-interest-speakers

_Declaration of interest for Speakers_  · 5 blocks · block types: section×2, text×2, form-embed×1

**Flags:** custom/dynamic blocks: form-embed; possible superseded duplicate of "declaration-of-interests-for-invited-speakers"; no hero block (atypical layout)

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | 172 | 150 |
| Content width | 856 | 900 |
| Content right margin | 172 | 150 |
| band[0] pad (T·R·B·L) / innerTop | 0·0·0·0 / 120 | 24 / 56 |
| band[1] pad (T·R·B·L) / innerTop | 24·24·24·24 / 40 | 24 / 56 |
| Vertical gaps (top 5) | 72px×1, 176px×1 | 56 between sections |

**Deltas beyond tolerance:** 8

- `contentLeftMargin`: 172 → 150 (Δ 22)
- `contentWidth`: 856 → 900 (Δ -44)
- `contentRightMargin`: 172 → 150 (Δ 22)
- `band[0].padTop`: 0 → 24 (Δ -24)
- `band[0].padRight`: 0 → 24 (Δ -24)
- `band[0].padBottom`: 0 → 24 (Δ -24)
- `band[0].padLeft`: 0 → 24 (Δ -24)
- `band[0].innerTop`: 120 → 56 (Δ 64)

**Proposed safe geometry changes (dry-run):** 12 field edits · **proposed y-reflow shifts:** 3

- block `block-mpb9zsc4-kupj3f` (body): y 120 → 0
- block `block-mpfr72fp-txvgiw` (body): y 536 → 296
- block `block-mqp7eugc-1yljw7` (other): y 1136 → 880

---

### privacy-policy

_Privacy Policy_  · 4 blocks · block types: section×1, text×2, form-embed×1

**Flags:** custom/dynamic blocks: form-embed; no hero block (atypical layout)

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | 172 | 150 |
| Content width | 856 | 900 |
| Content right margin | 172 | 150 |
| band[0] pad (T·R·B·L) / innerTop | 0·0·0·0 / 32 | 24 / 56 |
| Vertical gaps (top 5) | 48px×1, -7960px×1 | 56 between sections |

**Deltas beyond tolerance:** 8

- `contentLeftMargin`: 172 → 150 (Δ 22)
- `contentWidth`: 856 → 900 (Δ -44)
- `contentRightMargin`: 172 → 150 (Δ 22)
- `band[0].padTop`: 0 → 24 (Δ -24)
- `band[0].padRight`: 0 → 24 (Δ -24)
- `band[0].padBottom`: 0 → 24 (Δ -24)
- `band[0].padLeft`: 0 → 24 (Δ -24)
- `band[0].innerTop`: 32 → 56 (Δ -24)

**Proposed safe geometry changes (dry-run):** 12 field edits · **proposed y-reflow shifts:** 3

- block `block-mpb9zsc4-kupj3f` (body): y 32 → 0
- block `block-mpfr72fp-txvgiw` (body): y 160 → 136
- block `block-mqp7eugc-1yljw7` (other): y 1136 → 9128

---

### professional-standards-commitee

_Professional Standards Committee_  · 4 blocks · block types: section×2, wall-of-fame×1, text×1

**Flags:** custom/dynamic blocks: wall-of-fame; possible superseded duplicate of "professional-standards-committee"; no hero block (atypical layout)

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | 96 | 150 |
| Content width | 1008 | 900 |
| Content right margin | 96 | 150 |
| band[0] pad (T·R·B·L) / innerTop | 24·24·24·24 / 156 | 24 / 56 |
| band[1] pad (T·R·B·L) / innerTop | 0·0·0·0 / — | 24 / 56 |
| Vertical gaps (top 5) | 20px×1 | 56 between sections |

**Deltas beyond tolerance:** 8

- `contentLeftMargin`: 96 → 150 (Δ -54)
- `contentWidth`: 1008 → 900 (Δ 108)
- `contentRightMargin`: 96 → 150 (Δ -54)
- `band[0].innerTop`: 156 → 56 (Δ 100)
- `band[1].padTop`: 0 → 24 (Δ -24)
- `band[1].padRight`: 0 → 24 (Δ -24)
- `band[1].padBottom`: 0 → 24 (Δ -24)
- `band[1].padLeft`: 0 → 24 (Δ -24)

**Proposed safe geometry changes (dry-run):** 10 field edits · **proposed y-reflow shifts:** 2

- block `block-mqphkf75-32jftu` (body): y 156 → 0
- block `block-mqph7lli-ylku3n` (other): y 768 → 648

---

### what-does-a-clincal-scientist-do

_What does a Clinical Scientist do_  · 42 blocks · block types: hero×2, text×20, image×9, symbol×1, card×3, section×1, divider×6

**Flags:** custom/dynamic blocks: symbol

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | 0 | 150 |
| Content width | 952 | 900 |
| Content right margin | 148 | 150 |
| hero[0] height / padX / fullBleed | 600 / 200·200 / true | 600 / 200 / true |
| hero[1] height / padX / fullBleed | 420 / 200·200 / true | 420 / 200 / true |
| band[0] pad (T·R·B·L) / innerTop | 24·24·24·24 / 43 | 24 / 56 |
| divider widths / thickness | 560,560,560,560,560,560 / 1,1,1,1,1,1 | 300/260 / 1 |
| Vertical gaps (top 5) | 0px×4, 16px×3, 32px×3, 36px×3, -4px×3 | 56 between sections |

**Deltas beyond tolerance:** 8

- `contentLeftMargin`: 0 → 150 (Δ -150)
- `contentWidth`: 952 → 900 (Δ 52)
- `divider[0].width`: 560 → 300 (Δ 260)
- `divider[1].width`: 560 → 300 (Δ 260)
- `divider[2].width`: 560 → 300 (Δ 260)
- `divider[3].width`: 560 → 300 (Δ 260)
- `divider[4].width`: 560 → 300 (Δ 260)
- `divider[5].width`: 560 → 300 (Δ 260)

**Proposed safe geometry changes (dry-run):** 16 field edits · **proposed y-reflow shifts:** 39

- block `block-mqskl8rn-eii577` (h2): y 784 → 840
- block `block-mqskl8rn-d7dajv` (body): y 880 → 932
- block `block-mquqp7sg-mwf9qh` (other): y 1368 → 1436
- block `block-mquqoz8s-l66e5y` (image): y 1448 → 1732
- block `block-mquqoz8s-qp2sqs` (h2): y 1584 → 1924
- block `block-mquqrzb6-dml1xq` (card): y 1696 → 2060
- block `block-mquqrzb6-kfumdo` (card): y 1696 → 2060
- block `block-mquqrzb6-992fti` (card): y 1696 → 2060

---

### what-does-a-nuclear-cardiologist-do

_What does a Nuclear Cardiologist do?_  · 42 blocks · block types: hero×2, text×20, image×9, symbol×1, card×3, section×1, divider×6

**Flags:** custom/dynamic blocks: symbol

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | 0 | 150 |
| Content width | 952 | 900 |
| Content right margin | 148 | 150 |
| hero[0] height / padX / fullBleed | 600 / 200·200 / true | 600 / 200 / true |
| hero[1] height / padX / fullBleed | 420 / 200·200 / true | 420 / 200 / true |
| band[0] pad (T·R·B·L) / innerTop | 24·24·24·24 / 43 | 24 / 56 |
| divider widths / thickness | 560,560,560,560,560,560 / 1,1,1,1,1,1 | 300/260 / 1 |
| Vertical gaps (top 5) | 0px×4, 16px×3, 32px×3, 36px×3, -4px×3 | 56 between sections |

**Deltas beyond tolerance:** 8

- `contentLeftMargin`: 0 → 150 (Δ -150)
- `contentWidth`: 952 → 900 (Δ 52)
- `divider[0].width`: 560 → 300 (Δ 260)
- `divider[1].width`: 560 → 300 (Δ 260)
- `divider[2].width`: 560 → 300 (Δ 260)
- `divider[3].width`: 560 → 300 (Δ 260)
- `divider[4].width`: 560 → 300 (Δ 260)
- `divider[5].width`: 560 → 300 (Δ 260)

**Proposed safe geometry changes (dry-run):** 16 field edits · **proposed y-reflow shifts:** 39

- block `block-mqskl8rn-eii577` (h2): y 784 → 840
- block `block-mqskl8rn-d7dajv` (body): y 880 → 932
- block `block-mquqp7sg-mwf9qh` (other): y 1368 → 1436
- block `block-mquqoz8s-l66e5y` (image): y 1448 → 1732
- block `block-mquqoz8s-qp2sqs` (h2): y 1584 → 1924
- block `block-mquqrzb6-dml1xq` (card): y 1696 → 2060
- block `block-mquqrzb6-kfumdo` (card): y 1696 → 2060
- block `block-mquqrzb6-992fti` (card): y 1696 → 2060

---

### what-does-a-nuclear-medicine-physician-do

_What does a Nuclear Medicine Physician do_  · 42 blocks · block types: hero×2, text×20, image×9, symbol×1, card×3, section×1, divider×6

**Flags:** custom/dynamic blocks: symbol

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | 0 | 150 |
| Content width | 952 | 900 |
| Content right margin | 148 | 150 |
| hero[0] height / padX / fullBleed | 600 / 200·200 / true | 600 / 200 / true |
| hero[1] height / padX / fullBleed | 420 / 200·200 / true | 420 / 200 / true |
| band[0] pad (T·R·B·L) / innerTop | 24·24·24·24 / 43 | 24 / 56 |
| divider widths / thickness | 560,560,560,560,560,560 / 1,1,1,1,1,1 | 300/260 / 1 |
| Vertical gaps (top 5) | 0px×4, 16px×3, 32px×3, 36px×3, -4px×3 | 56 between sections |

**Deltas beyond tolerance:** 8

- `contentLeftMargin`: 0 → 150 (Δ -150)
- `contentWidth`: 952 → 900 (Δ 52)
- `divider[0].width`: 560 → 300 (Δ 260)
- `divider[1].width`: 560 → 300 (Δ 260)
- `divider[2].width`: 560 → 300 (Δ 260)
- `divider[3].width`: 560 → 300 (Δ 260)
- `divider[4].width`: 560 → 300 (Δ 260)
- `divider[5].width`: 560 → 300 (Δ 260)

**Proposed safe geometry changes (dry-run):** 16 field edits · **proposed y-reflow shifts:** 39

- block `block-mqskl8rn-eii577` (h2): y 784 → 840
- block `block-mqskl8rn-d7dajv` (body): y 880 → 932
- block `block-mquqp7sg-mwf9qh` (other): y 1264 → 1324
- block `block-mquqoz8s-l66e5y` (image): y 1344 → 1620
- block `block-mquqoz8s-qp2sqs` (h2): y 1480 → 1812
- block `block-mquqrzb6-dml1xq` (card): y 1592 → 1948
- block `block-mquqrzb6-kfumdo` (card): y 1592 → 1948
- block `block-mquqrzb6-992fti` (card): y 1592 → 1948

---

### what-does-a-nuclear-medicine-physicist-do

_What does a Nuclear Medicine Physicist do?_  · 42 blocks · block types: hero×2, text×20, image×9, symbol×1, card×3, section×1, divider×6

**Flags:** custom/dynamic blocks: symbol

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | 0 | 150 |
| Content width | 952 | 900 |
| Content right margin | 148 | 150 |
| hero[0] height / padX / fullBleed | 600 / 200·200 / true | 600 / 200 / true |
| hero[1] height / padX / fullBleed | 420 / 200·200 / true | 420 / 200 / true |
| band[0] pad (T·R·B·L) / innerTop | 24·24·24·24 / 43 | 24 / 56 |
| divider widths / thickness | 560,560,560,560,560,560 / 1,1,1,1,1,1 | 300/260 / 1 |
| Vertical gaps (top 5) | 0px×4, 16px×3, 32px×3, 36px×3, -4px×3 | 56 between sections |

**Deltas beyond tolerance:** 8

- `contentLeftMargin`: 0 → 150 (Δ -150)
- `contentWidth`: 952 → 900 (Δ 52)
- `divider[0].width`: 560 → 300 (Δ 260)
- `divider[1].width`: 560 → 300 (Δ 260)
- `divider[2].width`: 560 → 300 (Δ 260)
- `divider[3].width`: 560 → 300 (Δ 260)
- `divider[4].width`: 560 → 300 (Δ 260)
- `divider[5].width`: 560 → 300 (Δ 260)

**Proposed safe geometry changes (dry-run):** 16 field edits · **proposed y-reflow shifts:** 39

- block `block-mqskl8rn-eii577` (h2): y 784 → 840
- block `block-mqskl8rn-d7dajv` (body): y 880 → 932
- block `block-mquqp7sg-mwf9qh` (other): y 1368 → 1436
- block `block-mquqoz8s-l66e5y` (image): y 1448 → 1732
- block `block-mquqoz8s-qp2sqs` (h2): y 1584 → 1924
- block `block-mquqrzb6-dml1xq` (card): y 1696 → 2060
- block `block-mquqrzb6-kfumdo` (card): y 1696 → 2060
- block `block-mquqrzb6-992fti` (card): y 1696 → 2060

---

### what-does-a-radionuclide-radiologist-do

_What does a Radionuclide Radiologist?_  · 42 blocks · block types: hero×2, text×20, image×9, symbol×1, card×3, section×1, divider×6

**Flags:** custom/dynamic blocks: symbol

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | 0 | 150 |
| Content width | 952 | 900 |
| Content right margin | 148 | 150 |
| hero[0] height / padX / fullBleed | 600 / 200·200 / true | 600 / 200 / true |
| hero[1] height / padX / fullBleed | 420 / 200·200 / true | 420 / 200 / true |
| band[0] pad (T·R·B·L) / innerTop | 24·24·24·24 / 43 | 24 / 56 |
| divider widths / thickness | 560,560,560,560,560,560 / 1,1,1,1,1,1 | 300/260 / 1 |
| Vertical gaps (top 5) | 0px×4, 16px×3, 32px×3, 36px×3, -4px×3 | 56 between sections |

**Deltas beyond tolerance:** 8

- `contentLeftMargin`: 0 → 150 (Δ -150)
- `contentWidth`: 952 → 900 (Δ 52)
- `divider[0].width`: 560 → 300 (Δ 260)
- `divider[1].width`: 560 → 300 (Δ 260)
- `divider[2].width`: 560 → 300 (Δ 260)
- `divider[3].width`: 560 → 300 (Δ 260)
- `divider[4].width`: 560 → 300 (Δ 260)
- `divider[5].width`: 560 → 300 (Δ 260)

**Proposed safe geometry changes (dry-run):** 16 field edits · **proposed y-reflow shifts:** 39

- block `block-mqskl8rn-eii577` (h2): y 784 → 840
- block `block-mqskl8rn-d7dajv` (body): y 880 → 932
- block `block-mquqp7sg-mwf9qh` (other): y 1368 → 1436
- block `block-mquqoz8s-l66e5y` (image): y 1448 → 1732
- block `block-mquqoz8s-qp2sqs` (h2): y 1584 → 1924
- block `block-mquqrzb6-dml1xq` (card): y 1696 → 2060
- block `block-mquqrzb6-kfumdo` (card): y 1696 → 2060
- block `block-mquqrzb6-992fti` (card): y 1696 → 2060

---

### bnms-governance

_Governance_  · 3 blocks · block types: section×1, text×1, accordion×1

**Flags:** possible superseded duplicate of "governance-and-policies"; no hero block (atypical layout)

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | 172 | 150 |
| Content width | 856 | 900 |
| Content right margin | 172 | 150 |
| band[0] pad (T·R·B·L) / innerTop | 0·0·0·0 / 56 | 24 / 56 |
| Vertical gaps (top 5) | 152px×1 | 56 between sections |

**Deltas beyond tolerance:** 7

- `contentLeftMargin`: 172 → 150 (Δ 22)
- `contentWidth`: 856 → 900 (Δ -44)
- `contentRightMargin`: 172 → 150 (Δ 22)
- `band[0].padTop`: 0 → 24 (Δ -24)
- `band[0].padRight`: 0 → 24 (Δ -24)
- `band[0].padBottom`: 0 → 24 (Δ -24)
- `band[0].padLeft`: 0 → 24 (Δ -24)

**Proposed safe geometry changes (dry-run):** 12 field edits · **proposed y-reflow shifts:** 2

- block `block-mpb9zsc4-kupj3f` (body): y 56 → 0
- block `block-mqpdvxmi-hg1xl2` (accordion): y 296 → 144

---

### guidelines-and-procedures

_Guidelines and procedures_  · 26 blocks · block types: hero×2, text×11, image×5, symbol×1, card×3, accordion×1, section×1, divider×2

**Flags:** custom/dynamic blocks: symbol

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | 104 | 150 |
| Content width | 952 | 900 |
| Content right margin | 148 | 150 |
| hero[0] height / padX / fullBleed | 600 / 200·200 / true | 600 / 200 / true |
| hero[1] height / padX / fullBleed | 450 / 100·100 / true | 420 / 200 / true |
| band[0] pad (T·R·B·L) / innerTop | 24·24·24·24 / 32 | 24 / 56 |
| divider widths / thickness | 560,560 / 1,1 | 300/260 / 1 |
| Vertical gaps (top 5) | 0px×4, 16px×2, 48px×2, 32px×1, 36px×1 | 56 between sections |

**Deltas beyond tolerance:** 7

- `contentLeftMargin`: 104 → 150 (Δ -46)
- `contentWidth`: 952 → 900 (Δ 52)
- `hero[1].padLeft`: 100 → 200 (Δ -100)
- `hero[1].padRight`: 100 → 200 (Δ -100)
- `band[0].innerTop`: 32 → 56 (Δ -24)
- `divider[0].width`: 560 → 300 (Δ 260)
- `divider[1].width`: 560 → 300 (Δ 260)

**Proposed safe geometry changes (dry-run):** 18 field edits · **proposed y-reflow shifts:** 23

- block `block-mqskl8rn-eii577` (h2): y 784 → 840
- block `block-mqskl8rn-d7dajv` (body): y 880 → 932
- block `block-mqup2y0y-ckavpi` (other): y 1268 → 1316
- block `block-mqup2km6-4morha` (image): y 1336 → 1612
- block `block-mqup2km6-3wdhdn` (h2): y 1472 → 1804
- block `block-mqup6s55-j51g95` (card): y 1600 → 1940
- block `block-mqup6s55-0mlii2` (card): y 1600 → 1940
- block `block-mqup6s55-q69c9x` (card): y 1600 → 1940

---

### radiographers-technologists-nurses-committee

_Radiographers Technologists Nurses Committee_  · 9 blocks · block types: section×2, wall-of-fame×1, text×3, image×3

**Flags:** custom/dynamic blocks: wall-of-fame; possible superseded duplicate of "radiographers-technologists-and-nurses-committee"; no hero block (atypical layout)

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | 96 | 150 |
| Content width | 1008 | 900 |
| Content right margin | 96 | 150 |
| band[0] pad (T·R·B·L) / innerTop | 0·0·0·0 / — | 24 / 56 |
| band[1] pad (T·R·B·L) / innerTop | 24·24·24·24 / 40 | 24 / 56 |
| Vertical gaps (top 5) | 25px×1, 29px×1, 64px×1, 96px×1 | 56 between sections |

**Deltas beyond tolerance:** 7

- `contentLeftMargin`: 96 → 150 (Δ -54)
- `contentWidth`: 1008 → 900 (Δ 108)
- `contentRightMargin`: 96 → 150 (Δ -54)
- `band[0].padTop`: 0 → 24 (Δ -24)
- `band[0].padRight`: 0 → 24 (Δ -24)
- `band[0].padBottom`: 0 → 24 (Δ -24)
- `band[0].padLeft`: 0 → 24 (Δ -24)

**Proposed safe geometry changes (dry-run):** 14 field edits · **proposed y-reflow shifts:** 7

- block `block-mqph7lli-ylku3n` (other): y 112 → 0
- block `block-mqphkf75-32jftu` (body): y 1936 → 1816
- block `block-mqphtyvn-a4la1c` (h2): y 3576 → 3416
- block `block-mqphv58m-eil5o9` (image): y 3657 → 3528
- block `block-mqphw7ds-8rsjdf` (image): y 3657 → 3528
- block `block-mqphwaav-xhc027` (image): y 3657 → 3528
- block `block-mqphyxvu-xdobol` (body): y 4126 → 4024

---

### research-champions-network

_Research Champions Network_  · 7 blocks · block types: section×2, text×3, wall-of-fame×1, video×1

**Flags:** custom/dynamic blocks: wall-of-fame, video; no hero block (atypical layout)

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | 96 | 150 |
| Content width | 1008 | 900 |
| Content right margin | 96 | 150 |
| band[0] pad (T·R·B·L) / innerTop | 0·0·0·0 / — | 24 / 56 |
| band[1] pad (T·R·B·L) / innerTop | 24·24·24·24 / 56 | 24 / 56 |
| Vertical gaps (top 5) | 24px×2, 16px×1, 88px×1 | 56 between sections |

**Deltas beyond tolerance:** 7

- `contentLeftMargin`: 96 → 150 (Δ -54)
- `contentWidth`: 1008 → 900 (Δ 108)
- `contentRightMargin`: 96 → 150 (Δ -54)
- `band[0].padTop`: 0 → 24 (Δ -24)
- `band[0].padRight`: 0 → 24 (Δ -24)
- `band[0].padBottom`: 0 → 24 (Δ -24)
- `band[0].padLeft`: 0 → 24 (Δ -24)

**Proposed safe geometry changes (dry-run):** 14 field edits · **proposed y-reflow shifts:** 5

- block `block-mqphkf75-32jftu` (body): y 160 → 0
- block `block-mqpjlpmd-58ds2x` (other): y 224 → 104
- block `block-mqpjdemy-ksr8v3` (body): y 856 → 768
- block `block-mqpjwptf-owa33d` (body): y 2400 → 2280
- block `block-mqpjgh04-m0f3cc` (other): y 2912 → 2824

---

### what-does-a-nuclear-medicine-nurse-do

_What does a Nuclear Medicine Nurse do_  · 38 blocks · block types: hero×2, text×18, image×8, symbol×1, card×3, section×1, divider×5

**Flags:** custom/dynamic blocks: symbol

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | 0 | 150 |
| Content width | 952 | 900 |
| Content right margin | 148 | 150 |
| hero[0] height / padX / fullBleed | 600 / 200·200 / true | 600 / 200 / true |
| hero[1] height / padX / fullBleed | 420 / 200·200 / true | 420 / 200 / true |
| band[0] pad (T·R·B·L) / innerTop | 24·24·24·24 / 43 | 24 / 56 |
| divider widths / thickness | 560,560,560,560,560 / 1,1,1,1,1 | 300/260 / 1 |
| Vertical gaps (top 5) | 0px×4, 16px×3, 32px×3, 36px×3, -4px×3 | 56 between sections |

**Deltas beyond tolerance:** 7

- `contentLeftMargin`: 0 → 150 (Δ -150)
- `contentWidth`: 952 → 900 (Δ 52)
- `divider[0].width`: 560 → 300 (Δ 260)
- `divider[1].width`: 560 → 300 (Δ 260)
- `divider[2].width`: 560 → 300 (Δ 260)
- `divider[3].width`: 560 → 300 (Δ 260)
- `divider[4].width`: 560 → 300 (Δ 260)

**Proposed safe geometry changes (dry-run):** 16 field edits · **proposed y-reflow shifts:** 35

- block `block-mqskl8rn-eii577` (h2): y 784 → 840
- block `block-mqskl8rn-d7dajv` (body): y 880 → 932
- block `block-mquqp7sg-mwf9qh` (other): y 1320 → 1396
- block `block-mquqoz8s-l66e5y` (image): y 1400 → 1692
- block `block-mquqoz8s-qp2sqs` (h2): y 1536 → 1884
- block `block-mquqrzb6-dml1xq` (card): y 1648 → 2020
- block `block-mquqrzb6-kfumdo` (card): y 1648 → 2020
- block `block-mquqrzb6-992fti` (card): y 1648 → 2020

---

### grants-travelling-fellowships

_Grants & Travelling Fellowships_  · 22 blocks · block types: hero×1, text×10, section×1, image×5, divider×3, button×2

**Flags:** possible superseded duplicate of "travelling-fellowships"

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | 152 | 150 |
| Content width | 952 | 900 |
| Content right margin | 120 | 150 |
| hero[0] height / padX / fullBleed | 600 / 200·200 / true | 600 / 200 / true |
| band[0] pad (T·R·B·L) / innerTop | 24·24·24·24 / 16 | 24 / 56 |
| divider widths / thickness | 560,560,560 / 1,1,1 | 300/260 / 1 |
| Vertical gaps (top 5) | 0px×3, 16px×3, 36px×1, 40px×1, 42px×1 | 56 between sections |

**Deltas beyond tolerance:** 6

- `contentWidth`: 952 → 900 (Δ 52)
- `contentRightMargin`: 120 → 150 (Δ -30)
- `band[0].innerTop`: 16 → 56 (Δ -40)
- `divider[0].width`: 560 → 300 (Δ 260)
- `divider[1].width`: 560 → 300 (Δ 260)
- `divider[2].width`: 560 → 300 (Δ 260)

**Proposed safe geometry changes (dry-run):** 11 field edits · **proposed y-reflow shifts:** 19

- block `block-mqskl8rn-eii577` (h2): y 784 → 840
- block `block-mqskl8rn-d7dajv` (body): y 880 → 932
- block `block-mr4laiya-1dayum` (image): y 1314 → 1380
- block `block-mr4laiya-3cnlt6` (h2): y 1450 → 1572
- block `block-mqtpkzwy-rs66wg` (image): y 1570 → 1708
- block `block-mqtq3twa-iyijkd` (image): y 1570 → 1708
- block `block-mqtocu5g-ha3i0k` (h3): y 1630 → 1828
- block `block-mqtocu5g-t9sdey` (h3): y 1630 → 1828

---

### join-bnms

_Join BNMS_  · 29 blocks · block types: hero×2, text×13, section×1, image×7, divider×2, pricing-table×1, symbol×2, form-embed×1

**Flags:** custom/dynamic blocks: pricing-table, symbol, form-embed

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | 124 | 150 |
| Content width | 952 | 900 |
| Content right margin | 124 | 150 |
| hero[0] height / padX / fullBleed | 600 / 200·200 / true | 600 / 200 / true |
| hero[1] height / padX / fullBleed | 400 / 200·200 / true | 420 / 200 / true |
| band[0] pad (T·R·B·L) / innerTop | 24·24·24·24 / 32 | 24 / 56 |
| divider widths / thickness | 560,560 / 1,1 | 300/260 / 1 |
| Vertical gaps (top 5) | 0px×4, 16px×4, 32px×3, 8px×2, -208px×2 | 56 between sections |

**Deltas beyond tolerance:** 6

- `contentLeftMargin`: 124 → 150 (Δ -26)
- `contentWidth`: 952 → 900 (Δ 52)
- `contentRightMargin`: 124 → 150 (Δ -26)
- `band[0].innerTop`: 32 → 56 (Δ -24)
- `divider[0].width`: 560 → 300 (Δ 260)
- `divider[1].width`: 560 → 300 (Δ 260)

**Proposed safe geometry changes (dry-run):** 16 field edits · **proposed y-reflow shifts:** 26

- block `block-mqskl8rn-eii577` (h2): y 784 → 840
- block `block-mqskl8rn-d7dajv` (body): y 896 → 932
- block `block-mqtpkzwy-rs66wg` (image): y 1272 → 1332
- block `block-mqtq3twa-iyijkd` (image): y 1272 → 1332
- block `block-mqtocu5g-ha3i0k` (h3): y 1332 → 1452
- block `block-mqtocu5g-t9sdey` (h3): y 1332 → 1452
- block `block-mqtpy4bh-8aqqye` (divider): y 1364 → 1520
- block `block-mqtpywzr-ne4zp3` (divider): y 1364 → 1520

---

### student-resources

_Student Resources_  · 31 blocks · block types: hero×2, text×12, image×6, symbol×1, card×7, section×1, divider×2

**Flags:** custom/dynamic blocks: symbol

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | 124 | 150 |
| Content width | 952 | 900 |
| Content right margin | 124 | 150 |
| hero[0] height / padX / fullBleed | 600 / 200·200 / true | 600 / 200 / true |
| hero[1] height / padX / fullBleed | 400 / 200·200 / true | 420 / 200 / true |
| band[0] pad (T·R·B·L) / innerTop | 24·24·24·24 / 32 | 24 / 56 |
| divider widths / thickness | 560,560 / 1,1 | 300/260 / 1 |
| Vertical gaps (top 5) | 0px×5, 16px×2, 32px×2, 36px×2, 40px×2 | 56 between sections |

**Deltas beyond tolerance:** 6

- `contentLeftMargin`: 124 → 150 (Δ -26)
- `contentWidth`: 952 → 900 (Δ 52)
- `contentRightMargin`: 124 → 150 (Δ -26)
- `band[0].innerTop`: 32 → 56 (Δ -24)
- `divider[0].width`: 560 → 300 (Δ 260)
- `divider[1].width`: 560 → 300 (Δ 260)

**Proposed safe geometry changes (dry-run):** 16 field edits · **proposed y-reflow shifts:** 28

- block `block-mqskl8rn-eii577` (h2): y 784 → 840
- block `block-mqskl8rn-d7dajv` (body): y 880 → 932
- block `block-mqv0iugt-0s62x7` (other): y 1256 → 1324
- block `block-mqv0ilm2-dcmc1q` (image): y 1320 → 1620
- block `block-mqv0ilm2-3pxk45` (h2): y 1456 → 1812
- block `block-mqv0km70-mq40f0` (card): y 1568 → 1948
- block `block-mqv0mwqw-3wnprn` (card): y 1568 → 1948
- block `block-mqv0mzb3-vd2nap` (card): y 1568 → 1948

---

### what-is-nuclear-medicine

_What is Nuclear Medicine_  · 36 blocks · block types: hero×2, text×17, image×8, symbol×2, video×1, button×1, section×1, divider×4

**Flags:** custom/dynamic blocks: symbol, video

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | 152 | 150 |
| Content width | 904 | 900 |
| Content right margin | 144 | 150 |
| hero[0] height / padX / fullBleed | 600 / 200·200 / true | 600 / 200 / true |
| hero[1] height / padX / fullBleed | 500 / 200·200 / true | 420 / 200 / true |
| band[0] pad (T·R·B·L) / innerTop | 24·24·24·24 / 32 | 24 / 56 |
| divider widths / thickness | 560,560,560,560 / 1,1,1,1 | 300/260 / 1 |
| Vertical gaps (top 5) | 16px×6, 0px×4, 36px×2, 48px×2, -4px×2 | 56 between sections |

**Deltas beyond tolerance:** 6

- `hero[1].height`: 500 → 420 (Δ 80)
- `band[0].innerTop`: 32 → 56 (Δ -24)
- `divider[0].width`: 560 → 300 (Δ 260)
- `divider[1].width`: 560 → 300 (Δ 260)
- `divider[2].width`: 560 → 300 (Δ 260)
- `divider[3].width`: 560 → 300 (Δ 260)

**Proposed safe geometry changes (dry-run):** 18 field edits · **proposed y-reflow shifts:** 33

- block `block-mqskl8rn-eii577` (h2): y 784 → 840
- block `block-mqskl8rn-d7dajv` (body): y 880 → 932
- block `block-mqv38vzx-no4eiw` (other): y 1320 → 1404
- block `block-mqv38kml-rvpluq` (image): y 1368 → 1700
- block `block-mqv38kml-jm5mav` (h2): y 1504 → 1892
- block `block-mqv38kml-9omb9x` (body): y 1600 → 1984
- block `block-mqv3b3m4-lljegi` (other): y 1920 → 2344
- block `block-mqv3fi5h-0cmmuf` (button): y 2416 → 2864

---

### give-as-you-live

_Give As You Live_  · 24 blocks · block types: hero×2, text×12, section×1, image×5, divider×2, symbol×1, video×1

**Flags:** custom/dynamic blocks: symbol, video

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | 148 | 150 |
| Content width | 952 | 900 |
| Content right margin | 148 | 150 |
| hero[0] height / padX / fullBleed | 600 / 200·200 / true | 600 / 200 / true |
| hero[1] height / padX / fullBleed | 600 / 200·200 / true | 420 / 200 / true |
| band[0] pad (T·R·B·L) / innerTop | 24·24·24·24 / 32 | 24 / 56 |
| divider widths / thickness | 560,560 / 1,1 | 300/260 / 1 |
| Vertical gaps (top 5) | 0px×3, 16px×3, 24px×2, 32px×1, 36px×1 | 56 between sections |

**Deltas beyond tolerance:** 5

- `contentWidth`: 952 → 900 (Δ 52)
- `hero[1].height`: 600 → 420 (Δ 180)
- `band[0].innerTop`: 32 → 56 (Δ -24)
- `divider[0].width`: 560 → 300 (Δ 260)
- `divider[1].width`: 560 → 300 (Δ 260)

**Proposed safe geometry changes (dry-run):** 16 field edits · **proposed y-reflow shifts:** 20

- block `block-mqskl8rn-eii577` (h2): y 784 → 840
- block `block-mqskl8rn-d7dajv` (body): y 880 → 932
- block `block-mqtpkzwy-rs66wg` (image): y 1328 → 1380
- block `block-mqtq3twa-iyijkd` (image): y 1328 → 1380
- block `block-mqtocu5g-ha3i0k` (h3): y 1388 → 1500
- block `block-mqtocu5g-t9sdey` (h3): y 1388 → 1500
- block `block-mqtpy4bh-8aqqye` (divider): y 1420 → 1568
- block `block-mqtpywzr-ne4zp3` (divider): y 1420 → 1568

---

### overseas-professionals

_Overseas Professionals_  · 30 blocks · block types: hero×2, text×12, image×6, symbol×1, card×6, section×1, divider×2

**Flags:** custom/dynamic blocks: symbol

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | 124 | 150 |
| Content width | 952 | 900 |
| Content right margin | 124 | 150 |
| hero[0] height / padX / fullBleed | 600 / 200·200 / true | 600 / 200 / true |
| hero[1] height / padX / fullBleed | 450 / 200·200 / true | 420 / 200 / true |
| band[0] pad (T·R·B·L) / innerTop | 24·24·24·24 / 40 | 24 / 56 |
| divider widths / thickness | 560,560 / 1,1 | 300/260 / 1 |
| Vertical gaps (top 5) | 0px×5, 40px×3, 16px×2, 48px×2, 36px×1 | 56 between sections |

**Deltas beyond tolerance:** 5

- `contentLeftMargin`: 124 → 150 (Δ -26)
- `contentWidth`: 952 → 900 (Δ 52)
- `contentRightMargin`: 124 → 150 (Δ -26)
- `divider[0].width`: 560 → 300 (Δ 260)
- `divider[1].width`: 560 → 300 (Δ 260)

**Proposed safe geometry changes (dry-run):** 16 field edits · **proposed y-reflow shifts:** 27

- block `block-mqskl8rn-eii577` (h2): y 784 → 840
- block `block-mqskl8rn-d7dajv` (body): y 880 → 932
- block `block-mquz1trg-x5yjkq` (other): y 1256 → 1316
- block `block-mquz1ml3-ptrhbp` (image): y 1320 → 1612
- block `block-mquz1ml3-pbmxzg` (h2): y 1456 → 1804
- block `block-mquz3g0h-vi14uz` (card): y 1576 → 1940
- block `block-mquz3g0h-zuyydv` (card): y 1576 → 1940
- block `block-mquz3g0h-881kwy` (card): y 1576 → 1940

---

### student-volunteers

_Student Volunteers_  · 30 blocks · block types: hero×2, text×15, image×6, symbol×1, card×3, section×1, divider×2

**Flags:** custom/dynamic blocks: symbol

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | 124 | 150 |
| Content width | 952 | 900 |
| Content right margin | 148 | 150 |
| hero[0] height / padX / fullBleed | 600 / 200·200 / true | 600 / 200 / true |
| hero[1] height / padX / fullBleed | 400 / 200·200 / true | 420 / 200 / true |
| band[0] pad (T·R·B·L) / innerTop | 24·24·24·24 / 32 | 24 / 56 |
| divider widths / thickness | 560,560 / 1,1 | 300/260 / 1 |
| Vertical gaps (top 5) | 0px×5, 16px×3, 24px×3, 32px×1, 36px×1 | 56 between sections |

**Deltas beyond tolerance:** 5

- `contentLeftMargin`: 124 → 150 (Δ -26)
- `contentWidth`: 952 → 900 (Δ 52)
- `band[0].innerTop`: 32 → 56 (Δ -24)
- `divider[0].width`: 560 → 300 (Δ 260)
- `divider[1].width`: 560 → 300 (Δ 260)

**Proposed safe geometry changes (dry-run):** 22 field edits · **proposed y-reflow shifts:** 27

- block `block-mqskl8rn-eii577` (h2): y 784 → 840
- block `block-mqskl8rn-d7dajv` (body): y 880 → 932
- block `block-mquo4bs4-dn4dhc` (other): y 1264 → 1316
- block `block-mquo3zy6-vht5jr` (image): y 1336 → 1612
- block `block-mquo3zy6-iq3ksp` (h2): y 1472 → 1804
- block `block-mquo5kir-raqr0q` (card): y 1576 → 1940
- block `block-mquo5kis-y1hl2k` (card): y 1576 → 1940
- block `block-mquo5kis-ovx0ad` (card): y 1576 → 1940

---

### children-and-families

_Children and Families_  · 15 blocks · block types: hero×2, text×8, image×3, symbol×2

**Flags:** custom/dynamic blocks: symbol

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | 124 | 150 |
| Content width | 952 | 900 |
| Content right margin | 124 | 150 |
| hero[0] height / padX / fullBleed | 600 / 200·200 / true | 600 / 200 / true |
| hero[1] height / padX / fullBleed | 600 / 200·200 / true | 420 / 200 / true |
| Vertical gaps (top 5) | 16px×4, 0px×3, 48px×3, 40px×2, -192px×2 | 56 between sections |

**Deltas beyond tolerance:** 4

- `contentLeftMargin`: 124 → 150 (Δ -26)
- `contentWidth`: 952 → 900 (Δ 52)
- `contentRightMargin`: 124 → 150 (Δ -26)
- `hero[1].height`: 600 → 420 (Δ 180)

**Proposed safe geometry changes (dry-run):** 14 field edits · **proposed y-reflow shifts:** 13

- block `block-mqskl8rn-eii577` (h2): y 784 → 840
- block `block-mqskl8rn-d7dajv` (body): y 880 → 932
- block `block-mqv3y8b3-utcrv2` (other): y 1224 → 1284
- block `block-mqv3xxjz-72ib9b` (image): y 1272 → 1580
- block `block-mqv3xxjz-iyp7yv` (h2): y 1408 → 1772
- block `block-mqv3xxjz-4skahy` (body): y 1504 → 1864
- block `block-mqv40thz-1sxd7k` (h2): y 1984 → 2360
- block `block-mqv40thz-ed6o5x` (body): y 2080 → 2452

---

### spring-meeting-2026-resources

_Spring Meeting 2026 Resources_  · 6 blocks · block types: resource-list×1, text×1, image×1, divider×1, hero×1, spacer×1

**Flags:** custom/dynamic blocks: resource-list; event/meeting page (schedule-like layout)

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | 124 | 150 |
| Content width | 952 | 900 |
| Content right margin | 124 | 150 |
| hero[0] height / padX / fullBleed | 600 / 200·200 / true | 600 / 200 / true |
| divider widths / thickness | 560 / 1 | 300/260 / 1 |
| Vertical gaps (top 5) | 0px×2, 16px×2, -40px×1 | 56 between sections |

**Deltas beyond tolerance:** 4

- `contentLeftMargin`: 124 → 150 (Δ -26)
- `contentWidth`: 952 → 900 (Δ 52)
- `contentRightMargin`: 124 → 150 (Δ -26)
- `divider[0].width`: 560 → 300 (Δ 260)

**Proposed safe geometry changes (dry-run):** 2 field edits · **proposed y-reflow shifts:** 5

- block `block-mr3qcobl-cmskhr` (image): y 600 → 648
- block `block-mr3qcobl-4cidg5` (h2): y 736 → 840
- block `block-mr3qcobl-g3ovak` (divider): y 832 → 932
- block `block-mr3ivuoa-gwb6qa` (other): y 872 → 976
- block `block-mr3qhlwx-buqqsx` (other): y 2464 → 2664

---

### careers-in-nuclear-medicine

_Careers in Nuclear Medicine_  · 29 blocks · block types: hero×2, text×7, image×5, symbol×1, card×14

**Flags:** custom/dynamic blocks: symbol

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | 124 | 150 |
| Content width | 952 | 900 |
| Content right margin | 124 | 150 |
| hero[0] height / padX / fullBleed | 600 / 200·200 / true | 600 / 200 / true |
| hero[1] height / padX / fullBleed | 400 / 200·200 / true | 420 / 200 / true |
| Vertical gaps (top 5) | 0px×5, 16px×2, 40px×2, 48px×2, 20px×1 | 56 between sections |

**Deltas beyond tolerance:** 3

- `contentLeftMargin`: 124 → 150 (Δ -26)
- `contentWidth`: 952 → 900 (Δ 52)
- `contentRightMargin`: 124 → 150 (Δ -26)

**Proposed safe geometry changes (dry-run):** 14 field edits · **proposed y-reflow shifts:** 27

- block `block-mqskl8rn-eii577` (h2): y 784 → 840
- block `block-mqskl8rn-d7dajv` (body): y 880 → 932
- block `block-mquy0l4l-3bal3c` (other): y 1336 → 1396
- block `block-mquy00za-iiysse` (image): y 1400 → 1692
- block `block-mquy00za-t0mr8q` (h2): y 1536 → 1884
- block `block-mquy3765-eot887` (card): y 1656 → 2020
- block `block-mquy3765-5uajzo` (card): y 1656 → 2020
- block `block-mquy3765-gt5xtv` (card): y 1656 → 2020

---

### patient-information-leaflets

_Patient information leaflets_  · 14 blocks · block types: hero×2, text×6, image×3, resource-list×1, button×1, symbol×1

**Flags:** custom/dynamic blocks: resource-list, symbol

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | 152 | 150 |
| Content width | 952 | 900 |
| Content right margin | 124 | 150 |
| hero[0] height / padX / fullBleed | 600 / 200·200 / true | 600 / 200 / true |
| hero[1] height / padX / fullBleed | 500 / 200·200 / true | 420 / 200 / true |
| Vertical gaps (top 5) | 0px×5, 16px×3, 48px×2, 32px×1, 96px×1 | 56 between sections |

**Deltas beyond tolerance:** 3

- `contentWidth`: 952 → 900 (Δ 52)
- `contentRightMargin`: 124 → 150 (Δ -26)
- `hero[1].height`: 500 → 420 (Δ 80)

**Proposed safe geometry changes (dry-run):** 10 field edits · **proposed y-reflow shifts:** 12

- block `block-mqskl8rn-eii577` (h2): y 784 → 840
- block `block-mqskl8rn-d7dajv` (body): y 880 → 932
- block `block-mqv49q4s-c9cvxb` (other): y 1208 → 1284
- block `block-mqv4f47s-rx367b` (image): y 1992 → 2124
- block `block-mqv4f47r-14vmwx` (h2): y 2128 → 2316
- block `block-mqv4f47r-2h713u` (body): y 2224 → 2408
- block `block-mqv4hoe4-nym7lc` (button): y 2456 → 2696
- block `block-mqv4l4b8-bmg0sz` (other): y 2600 → 2800

---

### responsible-fundraising

_Responsible Fundraising_  · 14 blocks · block types: hero×2, text×5, image×3, symbol×1, card×3

**Flags:** custom/dynamic blocks: symbol

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | 124 | 150 |
| Content width | 952 | 900 |
| Content right margin | 124 | 150 |
| hero[0] height / padX / fullBleed | 600 / 200·200 / true | 600 / 200 / true |
| hero[1] height / padX / fullBleed | 450 / 200·200 / true | 420 / 200 / true |
| Vertical gaps (top 5) | 0px×3, 16px×2, 24px×1, 32px×1, 48px×1 | 56 between sections |

**Deltas beyond tolerance:** 3

- `contentLeftMargin`: 124 → 150 (Δ -26)
- `contentWidth`: 952 → 900 (Δ 52)
- `contentRightMargin`: 124 → 150 (Δ -26)

**Proposed safe geometry changes (dry-run):** 10 field edits · **proposed y-reflow shifts:** 12

- block `block-mqskl8rn-eii577` (h2): y 784 → 840
- block `block-mqskl8rn-d7dajv` (body): y 880 → 932
- block `block-mquwcruu-2e1l7d` (other): y 1128 → 1212
- block `block-mquwchvn-8h00d9` (image): y 1176 → 1508
- block `block-mquwchvn-qxzi6t` (h2): y 1312 → 1700
- block `block-mquwdni1-rutt47` (card): y 1424 → 1836
- block `block-mquwdni2-dnag0k` (card): y 1424 → 1836
- block `block-mquwdni2-91raua` (card): y 1424 → 1836

---

### honorary-members

_Honorary members_  · 6 blocks · block types: hero×1, wall-of-fame×1, text×2, image×1, divider×1

**Flags:** custom/dynamic blocks: wall-of-fame; possible superseded duplicate of "honory-membership"

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | 148 | 150 |
| Content width | 904 | 900 |
| Content right margin | 148 | 150 |
| hero[0] height / padX / fullBleed | 600 / 200·200 / true | 600 / 200 / true |
| divider widths / thickness | 560 / 1 | 300/260 / 1 |
| Vertical gaps (top 5) | 0px×1, 16px×1, 24px×1, 32px×1, 40px×1 | 56 between sections |

**Deltas beyond tolerance:** 1

- `divider[0].width`: 560 → 300 (Δ 260)

**Proposed safe geometry changes (dry-run):** 4 field edits · **proposed y-reflow shifts:** 4

- block `block-mqtvgvlq-f6o019` (h2): y 776 → 840
- block `block-mqtvgvlq-h6ollh` (body): y 872 → 932
- block `block-mqtvgvlq-64n797` (divider): y 1240 → 1324
- block `block-mqsiahmy-ym9wtk` (other): y 1288 → 1368

---

### spring-meeting-2026-photos

_Spring Meeting 2026 Photos_  · 12 blocks · block types: gallery×10, hero×1, spacer×1

**Flags:** custom/dynamic blocks: gallery; event/meeting page (schedule-like layout)

| Metric | Current | Target |
| --- | ---: | ---: |
| Content left margin | — | 150 |
| Content width | — | 900 |
| Content right margin | — | 150 |
| hero[0] height / padX / fullBleed | 600 / 200·200 / true | 600 / 200 / true |
| Vertical gaps (top 5) | 58px×2, 24px×1, 43px×1, 48px×1, 57px×1 | 56 between sections |

**Deltas beyond tolerance:** 0

**Proposed safe geometry changes (dry-run):** 0 field edits · **proposed y-reflow shifts:** 2

- block `block-mr3c7axh-jwkplx` (other): y 2572 → 3056
- block `block-mr3pfl20-li0en8` (other): y 3016 → 3532

---
