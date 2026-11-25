# dsh-ez-tree

This repository owns the skill-driven EZ-Tree editor loaded in the host's existing right-side browser, native session tools, and optional independent desktop/MCP compatibility. Keep business implementation out of the Seal host. Do not add a permanent navigation entry or custom sidebar pane. Preserve vendor files and provenance; change adapters in app/ instead. Do not depend on sibling development checkouts at runtime.

Engineering contracts live in `docs/contracts.md`. When working alongside Seal Harness, use its existing Trellis workflow and applicable engineering/application contracts; the initial delivery task is `11-25-dsh-ez-tree` in that checkout. Do not initialize or overwrite another project's Trellis template.

Use Node ^22.19.0 or >=24, npm ci, npm run check. Explicit graphical launch only. Headless verification must keep windows hidden and never take mouse/keyboard focus. Release app/manifest/plugin versions must match. Never mark an untested platform verified.

If .codegraph/ exists, reach for CodeGraph before text search when locating code. Run release checks against actual packed files. Commit source only; dist/lib are generated release attachments.
