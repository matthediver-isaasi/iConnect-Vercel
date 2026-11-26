---
name: Sales and Projects task modes
description: Owner-approved per-opportunity choice of task source and preservation boundaries.
---
The user said they are not yet using Sales, so existing Sales tasks can be ignored for migration purposes. Keep the existing feature and make standard Sales tasks versus project-board tasks a per-opportunity setting.

**Why:** The user explicitly chose retaining both options rather than replacing standard tasks with Projects. This supersedes the uploaded brief's request to retire the separate Sales task implementation.

**How to apply:** Default existing opportunities to standard tasks. Switching modes must not copy, migrate or delete either task set; inactive tasks remain preserved. A retained board association does not mean both task sources are active. Unlinking never deletes the board or tasks.

Project membership does not confer Sales visibility, and Sales administration does not confer project membership.

**Why:** Linking existing boards can involve a different audience from the opportunity. Automatic access inheritance could expose sensitive commercial details or unrelated existing board tasks.

**How to apply:** Require both access paths for combined task views and opportunity details on boards. Display the salesperson from Sales rather than silently enrolling that person in a shared board.

Do not treat the original Projects schema script or a passing minimal fixture as proof of live identity-schema compatibility.

**Why:** The live identity model has evolved independently of the original Projects tables; a fixture based on the old script missed a real migration compilation failure.

**How to apply:** Inspect the destination metadata for every identity/name field used by new joins, and model those types and fields in disposable database tests before applying integration migrations.

Product-driven acceptance tasks are opt-in and forward-only. Use the issued product snapshot and the opportunity task mode at acceptance; retries must not silently migrate work to another mode or board.

**Why:** The user approved support for both task systems without changing existing products or historically accepted quotes. Board configuration failures should not reject a customer's quote acceptance.

**How to apply:** Preserve pending work for explicit recovery, retain completed-task evidence even if a card is deleted, and keep prices, customer details and quote bearer links out of board cards. One task represents a line/component with its quantity, not one task per purchased unit.

Quote acceptance must support both staff recording customer approval in the admin and customers approving through the emailed link.

**Why:** The user explicitly requires both routes to be valid, without waiting for email approval when consent was obtained elsewhere.

**How to apply:** Preserve the actor and source of acceptance in history and run the same configured acceptance automation for either route.

Project-mode acceptance tasks automatically create/reuse the tenant-named list (default "Quote tasks") on the linked board; selecting a destination list is no longer a prerequisite.

**Why:** The user explicitly replaced the manual list prerequisite with automatic creation and a Sales-settings name. This authorizes server automation on an already linked board, not arbitrary boards.

**How to apply:** Preserve tenant/link/current board-manager boundaries and serialized creation. A renamed setting only affects future creation/retries; do not move old cards or rewrite issued snapshots.

The task choice (standard / create a board now / link an existing board) is made in the New opportunity dialog and then locked; mode change, relink and unlink are rejected afterwards. The owner deliberately dropped a "create board when won" option.

**Why:** Owner direction: boards must exist from creation so manual tasks can be added before any quote is accepted, and acceptance tasks always have a destination.

**How to apply:** Do not reintroduce mode switching or deferred board creation without new approval. The only post-creation exception is a legacy project-mode opportunity with no linked board, which may create/link once. Opportunity + board/link must be one transaction.

**One-off GFI exception approved on 2026-11-26:** Create and link private boards for the existing active won opportunities without boards, owned by their opportunity owners. Switching those opportunities from standard tasks to project tasks was approved; archived opportunities were explicitly excluded.

**Why:** The owner requested this specific live-data correction and accepted preserving existing standard tasks without generating historical quote tasks.

**How to apply:** This is not standing permission to switch other opportunities, automatically create boards on future wins, replay quote acceptance, or widen board membership. Preserve existing links and archived records on any verification or replay.
