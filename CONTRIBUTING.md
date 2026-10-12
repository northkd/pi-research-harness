# Contributing

Keep changes small and tied to a user-visible goal. Explain prerequisites,
known limitations and how the change was checked. Run `npm test`,
`npm run check:syntax` and `npm run check:release` before opening a pull request.

Do not submit credentials, private research inputs or machine-specific absolute
paths. Use examples and synthetic test data. Preserve the original license for
upstream code and state whether a patch is deployed, validated locally, or only
proposed. Do not advertise an unexecuted test or a model-provided label as proof.

New external services must be optional, clearly configured and never silently
substituted for another provider. No automated job submission, service restart
or global settings overwrite in a default install path.

Contributions to original project code are accepted under Apache License 2.0;
MIT dashboard excerpts remain under their original terms. See LICENSE/NOTICE.
