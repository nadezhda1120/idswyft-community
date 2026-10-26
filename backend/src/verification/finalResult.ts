/**
 * Final verification result from session state — pure, no I/O.
 *
 * Shared by the stateful API (via statusReader) and the stateless verification
 * server, which must load without the database.
 */
import { VerificationStatus, FLOW_PRESETS } from '@idswyft/shared';
import type { SessionState, FlowConfig } from '@idswyft/shared';

// ─── Step maps per flow ──────────────────────────────────────────
export const STEP_MAPS: Record<string, Record<string, number>> = {
  full: {
    AWAITING_FRONT: 1, FRONT_PROCESSING: 1,
    AWAITING_BACK: 2, BACK_PROCESSING: 2,
    CROSS_VALIDATING: 3,
    AWAITING_LIVE: 4, LIVE_PROCESSING: 4,
    FACE_MATCHING: 5,
    COMPLETE: 5, HARD_REJECTED: 0,
  },
  full_voice: {
    AWAITING_FRONT: 1, FRONT_PROCESSING: 1,
    AWAITING_BACK: 2, BACK_PROCESSING: 2,
    CROSS_VALIDATING: 3,
    AWAITING_LIVE: 4, LIVE_PROCESSING: 4,
    FACE_MATCHING: 5,
    AWAITING_VOICE: 6, VOICE_MATCHING: 6,
    COMPLETE: 6, HARD_REJECTED: 0,
  },
  document_only: {
    AWAITING_FRONT: 1, FRONT_PROCESSING: 1,
    AWAITING_BACK: 2, BACK_PROCESSING: 2,
    CROSS_VALIDATING: 3,
    COMPLETE: 3, HARD_REJECTED: 0,
  },
  identity: {
    AWAITING_FRONT: 1, FRONT_PROCESSING: 1,
    AWAITING_LIVE: 2, LIVE_PROCESSING: 2,
    FACE_MATCHING: 3,
    COMPLETE: 3, HARD_REJECTED: 0,
  },
  liveness_only: {
    AWAITING_LIVE: 1, LIVE_PROCESSING: 1,
    FACE_MATCHING: 1,
    COMPLETE: 1, HARD_REJECTED: 0,
  },
  age_only: {
    AWAITING_FRONT: 1, FRONT_PROCESSING: 1,
    COMPLETE: 1, HARD_REJECTED: 0,
  },
};

/** Map 10-state VerificationStatus to backward-compatible response format */
export function mapStatusForResponse(
  state: Readonly<SessionState>,
  flow: FlowConfig = FLOW_PRESETS.full,
): {
  status: string;
  current_step: number;
  total_steps: number;
  final_result: string | null;
} {
  // Use full_voice map when voice auth is active (monotonic step progression)
  const hasVoice = state.current_step === 'AWAITING_VOICE'
    || state.current_step === 'VOICE_MATCHING'
    || !!state.voice_match;
  const mapKey = (flow.preset === 'full' && hasVoice) ? 'full_voice' : flow.preset;
  const stepMap = STEP_MAPS[mapKey] ?? STEP_MAPS.full;

  let finalResult: string | null = null;
  if (state.current_step === VerificationStatus.COMPLETE) {
    if (flow.preset === 'age_only') {
      finalResult = 'verified';
    } else if (flow.preset === 'document_only') {
      // Document-only: final result based on cross-validation verdict alone
      // Passports skip cross-validation (single-sided) — verified if Gate 1 passed
      if (!state.cross_validation) {
        finalResult = 'verified';
      } else {
        const crossValVerdict = state.cross_validation.verdict;
        finalResult = crossValVerdict === 'REVIEW' ? 'manual_review'
          : crossValVerdict === 'REJECT' ? 'failed'
          : 'verified';
      }
    } else if (flow.preset === 'identity') {
      // Identity: no crossval, result based on face match only
      const needsReview = !!state.face_match?.skipped_reason;
      finalResult = needsReview ? 'manual_review' : 'verified';
    } else {
      // full / liveness_only: standard logic
      // Passports skip cross-validation, so only face match matters
      const needsReview = (state.cross_validation ? state.cross_validation.verdict === 'REVIEW' : false)
        || !!state.face_match?.skipped_reason;
      finalResult = needsReview ? 'manual_review' : 'verified';
    }
  } else if (state.current_step === VerificationStatus.HARD_REJECTED) {
    finalResult = 'failed';
  }

  return {
    status: state.current_step,
    current_step: stepMap[state.current_step] ?? 0,
    total_steps: hasVoice ? Math.max(flow.totalSteps, 6) : flow.totalSteps,
    final_result: finalResult,
  };
}
