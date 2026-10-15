# Security and data boundaries

Do not commit API keys, auth.json, actual models/providers configuration, SSH
private keys, browser cookies/profiles, research papers without redistribution
rights, personal conversations, session IDs or runtime logs. Private GitHub
repositories are external storage too.

The optional image extension requires an environment credential; the release
copy removes the local machine's hardcoded credential fallback. No real token
was intentionally copied into this repository. Existing machine credentials
must be managed/rotated locally; publishing a sanitized copy does not rotate them.

The dashboard is a control plane capable of running tools and changing files.
Bind it and Chrome CDP to loopback; use authenticated access/SSH forwarding.
Never expose a bare CDP port or management API on the public internet.

Agent tool allow-lists express a working contract, not a process sandbox. External
CLI runner/extension code can execute local programs. Review all code before
installation; authorize external providers and material scope explicitly.

Vendored skills retain upstream instructions and scripts. Installing or
advertising them does not authorize model calls, remote jobs, paid review,
watchdogs, hooks or uploads. Their tool/auto-proceed suggestions remain below
current user/project authorization. Reviewer MCP names in a document are not
registered or authenticated backends. Stop if an actual backend or material
export authorization is absent. Source copies are opt-in; installers reject
nonempty personal skill directories instead of silently merging or overwriting.

Mainline supervision is dormant until a project is explicitly authorized for an
exact locally configured model and minimum evidence scope. It is direction
review, not scientific or publication approval. Risk, missing evidence and
infrastructure failures are not global execution bans; raw-data, egress,
resource and irreversible-operation permissions remain independent. Human
branch decisions do not erase old findings or authorize future new scopes.

The additive dashboard layout/folding module changes rendered presentation
only. It makes no network/storage calls or source-text changes. Long content
has an explicit preview/full toggle; it is not data truncation or a privacy
redaction mechanism. Do not use it to hide secrets before screenshots or export.

The `check:release` script is a bounded publication allow-list/pattern audit,
not a comprehensive DLP scanner or a guarantee against every secret format.
Images require separate visual review. Report a suspected leaked credential
privately to the maintainer and rotate it; do not paste it in a public issue.
