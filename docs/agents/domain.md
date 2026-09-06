# Domain docs — single-context

Layout: one `CONTEXT.md` + `docs/adr/` at the repo root would be the single-context default — but `CONTEXT.md` is **deliberately not created yet** (per ground-truth rule: do not create eagerly).

Until real domain vocabulary accrues:

- Domain/vocabulary source of truth: `SPEC.md` (protocol envelope, translation rules, key-pool semantics) plus each effort spec's `Glossary` section.
- New terms: park them in the current spec's Glossary; only spin up `CONTEXT.md` / call `domain-modeling` when vocabulary genuinely fights back.
- Irreversible decisions (save format, protocol behavior, security posture): record as `docs/adr/NNNN-<slug>.md` (NNNN = max existing + 1; empty dir → `0001`). None exist yet.

Known recorded decisions that agents must respect:

- Management API returns plaintext keys with no auth **by explicit user decision** (operator-owned instance) — the optional `admin_token` is opt-in hardening, not a default flip.
- Single-file, zero-npm-dependency architecture is a hard constraint (TASK.md); do not introduce packages.
- `config.json` / `logs/` / `data/` are gitignored operator state; never commit their contents.
