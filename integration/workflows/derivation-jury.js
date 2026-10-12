const target = typeof args?.target === "string" ? args.target : "the supplied derivation";
const derivations = await runs.all([
  { key: "derivation-a", agent: "oracle", context: "fresh", task: `Derive ${target} from explicit assumptions. Return the full derivation text, list every proof obligation, and do not call another agent.` },
  { key: "derivation-b", agent: "oracle", context: "fresh", task: `Independently derive ${target} from the supplied assumptions. Return the full derivation text from a fresh context and expose counterexamples or missing lemmas.` },
]);
if (!Array.isArray(derivations) || derivations.length !== 2 || derivations.some((item) => item?.ok !== true)) return { status: "blocked", failedStep: "fresh-derivations", dispatchCount: 1, order: ["fresh-derivations"], derivations, majorityIsNotProof: true };
const bodies = derivations.map((item) => typeof item.output === "string" ? item.output : "");
if (bodies.some((body) => !body.trim())) return { status: "blocked", failedStep: "fresh-derivations", dispatchCount: 1, order: ["fresh-derivations"], derivations, reason: "Pi returned no derivation正文; run references are not proof input", majorityIsNotProof: true };
const counterexample = await runs.run("counterexample", {
  agent: "reviewer", context: "fresh",
  task: `Check both full fresh derivations below for a numerical counterexample, dimensional inconsistency, or explicit failed proof obligation. A majority vote is not a proof. Derivation A:\n${bodies[0]}\n\nDerivation B:\n${bodies[1]}`,
});
if (!counterexample || counterexample.ok !== true) return { status: "blocked", failedStep: "counterexample", dispatchCount: 2, order: ["fresh-derivations", "counterexample"], derivations, counterexample, majorityIsNotProof: true };
const jury = await runs.run("independent-jury", {
  agent: "codex-exec", context: "fresh",
  task: `Independently audit both derivations and the counterexample report. The external profile cannot certify the ARIS model/effort pin; preserve unresolved obligations and return blocked/provisional rather than accepted. Derivation A:\n${bodies[0]}\n\nDerivation B:\n${bodies[1]}\n\nCounterexample:\n${counterexample.output}`,
});
return { status: jury?.ok === true ? "provisional" : "blocked", failedStep: jury?.ok === true ? undefined : "independent-jury", dispatchCount: 3, order: ["fresh-derivations", "counterexample", "independent-jury"], derivations, counterexample, jury, majorityIsNotProof: true, unresolvedProofObligations: "must be extracted and resolved by a qualified reviewer" };
