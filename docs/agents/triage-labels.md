# Triage labels — defaults

The five canonical triage roles, label string equal to the role name:

| Label | Meaning |
|---|---|
| `needs-triage` | raw incoming, not yet classified |
| `needs-info` | waiting on facts from outside the repo |
| `ready-for-agent` | an agent can build it now |
| `ready-for-human` | AFK work done; a human pick/act remains |
| `wontfix` | closed with reason |

Written as the `Status:` line inside issue files (local-markdown tracker; no external label system).
