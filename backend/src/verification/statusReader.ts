/**
 * Read-only utilities for fetching verification session state.
 * Extracted from newVerification.ts to avoid dragging in service singletons
 * (OCR, face detection, etc.) when only read access is needed.
 */
import { supabase } from '@/config/database.js';
import { FLOW_PRESETS } from '@idswyft/shared';
import type { SessionState, FlowConfig } from '@idswyft/shared';
import { routingGeoFlags } from '@/services/geoAnalysis.js';

/** Load session state from verification_contexts table */
export async function loadSessionState(verificationId: string): Promise<SessionState | null> {
  const { data } = await supabase
    .from('verification_contexts')
    .select('context')
    .eq('verification_id', verificationId)
    .single();

  if (!data?.context) return null;
  return typeof data.context === 'string' ? JSON.parse(data.context) : data.context;
}

import { mapStatusForResponse } from './finalResult.js';
export { STEP_MAPS, mapStatusForResponse } from './finalResult.js';

/** Fetch computed risk score from verification_risk_scores table */
export async function fetchRiskScore(verificationId: string): Promise<{
  overall_score: number;
  risk_level: string;
  risk_factors: any[];
} | null> {
  const { data: riskRow } = await supabase
    .from('verification_risk_scores')
    .select('overall_score, risk_level, risk_factors')
    .eq('verification_request_id', verificationId)
    .single();

  if (!riskRow) return null;
  return {
    overall_score: riskRow.overall_score,
    risk_level: riskRow.risk_level,
    risk_factors: riskRow.risk_factors ?? [],
  };
}

// ─── Shared verification response builder ────────────────────────

export interface VerificationResponseInput {
  verificationId: string;
  state: SessionState;
  verification: {
    status: string;
    verification_mode?: string | null;
    is_sandbox?: boolean;
    duplicate_flags?: any;
    addons?: any;
    retry_count?: number;
    manual_review_reason?: string | null;
  };
  riskScore: { overall_score: number; risk_level: string; risk_factors: any[] } | null;
  flow?: FlowConfig;
}

/**
 * Build the canonical verification status response JSON.
 * Used by both GET /api/v2/verify/:id/status and GET /api/developer/verifications/:id.
 */
export function buildVerificationResponse(input: VerificationResponseInput) {
  const { verificationId, state, verification, riskScore } = input;
  const flow = input.flow ?? FLOW_PRESETS.full;
  const mapped = mapStatusForResponse(state, flow);
  const isAgeOnly = flow.preset === 'age_only';
  // country_mismatch is informational only — it never routes to review (issue #60),
  // so it must not surface as a review reason either.
  const geoReviewFlags = routingGeoFlags(state.geo_analysis?.flags ?? []);

  return {
    success: true,
    verification_id: verificationId,
    verification_mode: verification.verification_mode ?? null,
    is_sandbox: verification.is_sandbox ?? false,
    status: mapped.status,
    current_step: mapped.current_step,
    total_steps: mapped.total_steps,
    ...((state as any).age_verification && { age_verification: (state as any).age_verification }),
    front_document_uploaded: !!state.front_extraction,
    back_document_uploaded: !!state.back_extraction,
    live_capture_uploaded: !!state.face_match,
    ocr_data: isAgeOnly ? undefined : (state.front_extraction?.ocr ?? null),
    // Tamper scoring of the front document; computed on every upload, but
    // until now only logged.
    document_authenticity: state.front_extraction?.authenticity ?? null,
    barcode_data: state.back_extraction?.qr_payload ?? null,
    cross_validation_results: state.cross_validation ?? null,
    face_match_results: state.face_match ?? null,
    liveness_results: state.liveness ?? null,
    deepfake_check: state.deepfake_check ?? null,
    aml_screening: state.aml_screening ?? null,
    age_estimation: state.age_estimation ?? null,
    velocity_analysis: state.velocity_analysis ?? null,
    geo_analysis: state.geo_analysis ?? null,
    voice_match_results: state.voice_match ?? null,
    risk_score: riskScore,
    compliance_flags: (verification.addons as any)?.compliance_flags ?? null,
    duplicate_flags: verification.duplicate_flags ?? null,
    barcode_extraction_failed: state.back_extraction ? !state.back_extraction.qr_payload : null,
    documents_match: state.cross_validation ? !state.cross_validation.has_critical_failure : null,
    face_match_passed: state.face_match?.passed ?? null,
    liveness_passed: state.liveness?.passed ?? null,
    final_result: ['verified', 'failed', 'manual_review'].includes(verification.status)
      ? verification.status
      : mapped.final_result,
    rejection_reason: state.rejection_reason,
    rejection_detail: state.rejection_detail,
    failure_reason: state.rejection_detail,
    manual_review_reason: verification.manual_review_reason
      || (state.cross_validation?.verdict === 'REVIEW' ? 'Cross-validation requires review' : null)
      || (state.face_match?.skipped_reason ? `Face match skipped: ${state.face_match.skipped_reason}` : null)
      || ((state.velocity_analysis?.flags?.length ?? 0) > 0 ? `Velocity flags: ${state.velocity_analysis!.flags.join(', ')}` : null)
      || (geoReviewFlags.length > 0 ? `Geo flags: ${geoReviewFlags.join(', ')}` : null),
    ...(mapped.final_result === 'failed' && {
      retry_available: (verification.retry_count ?? 0) < 3,
      retry_count: verification.retry_count ?? 0,
    }),
    created_at: state.created_at,
    updated_at: state.updated_at,
  };
}
