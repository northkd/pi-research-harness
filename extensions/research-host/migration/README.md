# Pi Research state migration

The migration copies selected legacy records into a new, exclusive backup directory. Native Pi histories and project knowledge-base files stay at their original canonical paths. Existing sealed full-history plans bind the original `res-workflow` path and the device, inode, mtime and ctime of their artifacts, so that physical data directory also stays in place for the new host. The manifest records both groups with SHA-256 hashes, file identities and original modes. Copied files use mode `0600`; copied directories use mode `0700`.

`createDefaultMigrationPlan()` copies these roots when present.

- `~/.pi/dashboard/res-workflow`, access modes, task permissions, goals and attachments
- The current workbench-sync state
- Selected old settings under `data/legacy`, including private configuration, identity, credentials and grant records

The snapshot preserves each source file's bytes and each owner, project, adoption, charter and task identifier. The old private configuration is archival material. The host must generate or validate its own runtime configuration and credentials before startup.

The orchestrator calls `prepareMigration({ destinationDir, plan, assertQuiescent })` after stopping the old scheduler, sync writer and relevant Pi processes, with the new scheduler inactive. Its `assertQuiescent` callback must perform a fresh host-level check and return `{ ok: true, observedAt, evidence: [String] }`. It runs before copying and after copying. Missing or failed evidence rejects the copy. The migration also compares complete source and retained-file snapshots before and after copying.

The tool creates `destinationDir/data` plus `destinationDir/migration-manifest.json`. An existing destination is rejected. Failed snapshots retain a manifest marked `failed`; successful backups must pass `verifyMigration({ destinationDir, verifySources: true })` while writers are still stopped. The verification result lists `requiredRuntimeRoots`; the new host must use those original physical directories until a separately verified sealed-plan migration exists. The backup's `ready` status describes its byte verification. Runtime cutover still requires the host's business and restart tests.

Commands for read-only checks follow.

```sh
node migration/cli.mjs inventory
node migration/cli.mjs verify --destination /absolute/snapshot/path --sources
node migration/index.test.mjs
```

`--sources` compares the current old records and retained native histories with the frozen manifest. Run that check before resuming execution. Once the host writes new history, use the destination-only verification for the frozen copied records. Runtime data needs its own live integrity checks.

Rollback keeps the original data directories and service configuration available until the new host passes the full cutover checks. Before returning scheduling to the old host, stop the new writer and reconcile any new task, communication or session records. The snapshot contains the source state at cutover time. Replacing the original sealed-artifact directories from a copied backup would change filesystem identities, so verify the affected saved plans before selecting that recovery path.

Quiescence is a host-level fact. A stale PID file or an empty process list inside a restricted PID namespace cannot establish it. The migration tool does not stop services, change Pi settings or remove old files.
