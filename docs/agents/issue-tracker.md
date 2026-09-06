# Issue tracker — local markdown

Solo repo. Issues stay as local files in this repo (local-markdown tracker); the `origin` remote (`github.com/zkkk9555/cc-gateway`) is for publishing commits only — no GitHub Issues workflow. History was scrubbed of credentials before first push (2026-09-06, pre-push bundle kept at `C:\Project\cc-gateway-prepurge-20260906.bundle`).

- Effort root: `.scratch/<slug>/` (slug = `<verb>-<object>-<constraint>`, English kebab-case)
- Spec: `.scratch/<slug>/spec.md`
- Tickets (Lane C only): `.scratch/<slug>/issues/NN-<slug>.md`, blockers first; Lane B embeds 1–3 slices as a checklist in the spec instead of ticket files
- Stops: `.scratch/<slug>/BLOCKED.md` / `NEEDS-HUMAN.md`

`Status:` vocabulary for any ticket file: `needs-triage` | `needs-info` | `ready-for-agent` | `ready-for-human` | `wontfix`.

One effort = one `.scratch/<slug>/`; `.scratch/` is committed (spec/tickets are review artifacts). One commit per round, message cites the decision.
