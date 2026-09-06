# Issue tracker — local markdown

No git remote is configured; this is a solo repo. Issues live as files in this repo:

- Effort root: `.scratch/<slug>/` (slug = `<verb>-<object>-<constraint>`, English kebab-case)
- Spec: `.scratch/<slug>/spec.md`
- Tickets (Lane C only): `.scratch/<slug>/issues/NN-<slug>.md`, blockers first; Lane B embeds 1–3 slices as a checklist in the spec instead of ticket files
- Stops: `.scratch/<slug>/BLOCKED.md` / `NEEDS-HUMAN.md`

`Status:` vocabulary for any ticket file: `needs-triage` | `needs-info` | `ready-for-agent` | `ready-for-human` | `wontfix`.

One effort = one `.scratch/<slug>/`; `.scratch/` is committed (spec/tickets are review artifacts). One commit per round, message cites the decision.
