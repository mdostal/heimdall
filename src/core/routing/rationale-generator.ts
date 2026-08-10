import type { CandidateScore } from "./scorer.js";

export function generateRationale(
  chosen: CandidateScore,
  rankedCandidates: readonly CandidateScore[],
): string {
  const reasonsText = chosen.reasons.length > 0 ? chosen.reasons.join(", ") : "(none)";
  let rationale = `Chose ${chosen.lane_id} (score ${chosen.score}). Reasons: ${reasonsText}.`;

  const rejected = rankedCandidates.filter((candidate) => candidate.lane_id !== chosen.lane_id);
  if (rejected.length > 0) {
    const rejectedText = rejected
      .map((candidate) => {
        const topReason = candidate.reasons[0];
        return topReason
          ? `${candidate.lane_id} (score ${candidate.score}, ${topReason})`
          : `${candidate.lane_id} (score ${candidate.score})`;
      })
      .join(", ");
    rationale += ` Rejected: ${rejectedText}.`;
  }

  return rationale;
}
