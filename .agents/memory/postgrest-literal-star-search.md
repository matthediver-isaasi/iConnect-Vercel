---
name: PostgREST literal-star searches
description: Why escaping LIKE metacharacters alone does not make PostgREST text searches literal.
---

PostgREST rewrites every `*` in LIKE/ILIKE patterns to `%`, including backslash-escaped stars. Escaping `%`, `_`, and backslash is necessary but insufficient for arbitrary literal text.

**Why:** Verified in PostgREST's SQL formatter: LIKE and ILIKE map stars over the complete pattern before binding it. Quoting the value does not bypass this behavior.

**How to apply:** For literal-star searches use a supported case-insensitive regex operator with every regex metacharacter escaped, or another literal-text database operation. Keep added API support narrowly scoped; do not replace normal ILIKE searches globally.