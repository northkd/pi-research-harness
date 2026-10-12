# Research integration package

Thin local Pi package. It composes registered evidence tools with research-stage
contracts without inventing model identity, results or reviewer backends.

- `index.mjs`: registers `pi_research_fusion`.
- `src/routes.mjs`: requested vs observed model identity, supported route checks.
- `src/fusion.mjs`: search/fetch adapters and review/derivation evidence gates.
- `src/artifacts.mjs`: Feynman Markdown → ARIS plan/LaTeX/PDF/audit path mapping.
- `workflows/`: native Pi workflow statement bodies; not standalone Node scripts.
- `skills/`: wrappers that require separately installed canonical ARIS skills.
- `compatibility-matrix.*`: historical contract inventory, not runtime guarantees.

## Examples

```json
{"action":"search","source":"feynman","databaseSource":"openalex","query":"your research topic","limit":5}
{"action":"route","backend":"native","role":"author","model":"provider/your-model-id"}
{"action":"manifest","root":"/path/to/research-project","topic":"your topic","stages":[]}
```

`ready` means dispatch prerequisites are satisfied, not that a scientific answer
is correct or that a review passed. External CLI reviews remain advisory when
trusted identity/independence evidence is absent. Missing tools return blocked
status rather than silently choosing a different backend.

The ARIS reviewer pin in the route contract is retained as requested,
**unverified metadata**, not a guaranteed installed model. Use your authenticated
Pi catalogue and respect actual supported reasoning levels.

Run `node --test integration/test/*.test.mjs` from the repository root. Offline
contract tests do not prove live search, private model credentials, browser login,
SSH/HPC access, independent scientific validity or generated PDF correctness.

Portable wrapper paths use `~/.agents/skills` and `<PI_CODING_AGENT_DIR>` as
human-readable conventions; expand them to the actual installation path before
handing a file path to a read tool. Configure canonical ARIS/Feynman paths locally.
