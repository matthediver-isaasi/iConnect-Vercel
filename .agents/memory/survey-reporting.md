---
name: Survey reporting anonymity boundary
description: Durable privacy rules for any surface exposing survey results
---
- Anonymity for survey responses is governed by each response's immutable version-snapshot settings, never the live (mutable) survey settings — re-publishing a survey as identified must not re-identify historical anonymous responses, and switching to anonymous must not hide identified history.
- For mixed-version result sets the strictest protection wins: any anonymous rows use the max applicable threshold; below-threshold anonymous rows are withheld from every respondent-level view and export, per row.
- Suppression is evaluated on the *filtered* response set (narrow filters can isolate one respondent) and enforced server-side in every drilldown, view and export path; anonymous rows use generated, non-reversible references and never expose identity columns.
- **Why:** the threshold plus snapshot-governed identity is the entire privacy guarantee; one forgotten path or a live-settings shortcut silently leaks respondent identity.
