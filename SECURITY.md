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

The `check:release` script is a bounded publication allow-list/pattern audit,
not a comprehensive DLP scanner or a guarantee against every secret format.
Images require separate visual review. Report a suspected leaked credential
privately to the maintainer and rotate it; do not paste it in a public issue.
