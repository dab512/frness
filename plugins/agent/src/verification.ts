import { createHash } from "node:crypto";
import { canonicalJson, freezeJson } from "../../../packages/abi/src/json.js";
import { definitionKey } from "../../../packages/abi/src/references.js";
import type {
  DefinitionRef,
  Json,
  TypeRef,
  VersionedObjectRef,
} from "../../../specs/fractal-harness/contracts.js";
import type {
  AcceptedResult,
  Candidate,
  Verification,
} from "../../../specs/fractal-harness/standard-contracts.js";

export function candidateDigest(value: Pick<Candidate, "value" | "type" | "sources">): string {
  return `sha256:${createHash("sha256")
    .update(canonicalJson({ value: value.value, type: value.type, sources: value.sources }))
    .digest("hex")}`;
}
export function makeCandidate(
  value: Json,
  type: TypeRef,
  sources: readonly VersionedObjectRef[],
): Candidate {
  const candidate = { value, type, sources };
  return freezeJson(structuredClone({ ...candidate, digest: candidateDigest(candidate) }));
}
export function verificationFeedback(
  candidate: Candidate,
  verifications: readonly Verification[],
  required: readonly DefinitionRef[],
): readonly string[] {
  const feedback: string[] = [];
  if (candidate.digest !== candidateDigest(candidate))
    feedback.push("Candidate changed after its digest was recorded");
  const requiredKeys = new Set(required.map(definitionKey));
  if (requiredKeys.size === 0 || requiredKeys.size !== required.length)
    feedback.push("Required verifier policy is invalid");
  const seen = new Set<string>();
  for (const verification of verifications) {
    const key = definitionKey(verification.verifier);
    if (!requiredKeys.has(key) || seen.has(key)) feedback.push("Unexpected or duplicate verifier");
    seen.add(key);
    if (verification.candidateDigest !== candidate.digest)
      feedback.push("Verification refers to another candidate digest");
    if (verification.verdict !== "accept")
      feedback.push(`Verifier verdict: ${verification.verdict}`, ...verification.feedback);
  }
  for (const key of requiredKeys)
    if (!seen.has(key)) feedback.push("Required verifier response is missing");
  return feedback;
}
export function acceptCandidate(
  candidate: Candidate,
  verifications: readonly Verification[],
  required: readonly DefinitionRef[],
  warnings: readonly string[] = [],
): AcceptedResult {
  if (verificationFeedback(candidate, verifications, required).length)
    throw Object.assign(new Error("Candidate has no complete matching acceptance evidence"), {
      code: "VERIFICATION_REQUIRED",
    });
  return freezeJson(structuredClone({ candidate, verifications, warnings }));
}
