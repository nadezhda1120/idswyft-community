/**
 * Stateless verification — one request in, one decision out.
 *
 * Runs the same VerificationSession state machine and gates as the stateful API,
 * entirely in memory for the duration of the call: no database, no session id that
 * outlives the request, no file storage. The session object, the extraction results
 * and the uploaded buffers are dropped (buffers zero-filled) before returning.
 *
 * Decisions stay deterministic: gates, cross-validation and face matching are the
 * existing pure functions; only extraction calls the ML engine.
 */

import { randomUUID } from 'crypto';
import { FLOW_PRESETS, VerificationStatus } from '@idswyft/shared';
import type {
  FrontExtractionResult, BackExtractionResult, LiveCaptureResult,
  HeadTurnLivenessMetadata, VerificationMode, SessionState,
} from '@idswyft/shared';
import { VerificationSession } from '@/verification/session/VerificationSession.js';
import type { StepResult } from '@/verification/session/VerificationSession.js';
import { computeFaceMatch } from '@/verification/face/faceMatchService.js';
import { mapStatusForResponse } from '@/verification/finalResult.js';

/** Flows the stateless API supports, and which uploads each needs. */
export const STATELESS_FLOWS = {
  full:          { front: true,  back: true,  live: true },
  document_only: { front: true,  back: true,  live: false },
  identity:      { front: true,  back: false, live: true },
} as const satisfies Partial<Record<VerificationMode, { front: boolean; back: boolean; live: boolean }>>;

export type StatelessFlow = keyof typeof STATELESS_FLOWS;

export interface StatelessInput {
  front: Buffer;
  back?: Buffer;
  live?: Buffer;
  documentType: string;
  issuingCountry?: string;
  flow: StatelessFlow;
  headTurnMetadata?: HeadTurnLivenessMetadata;
  includeRawText?: boolean;
}

export interface StatelessDeps {
  extractFront: (buffer: Buffer, opts: { documentId: string; documentType: string; issuingCountry?: string }) => Promise<FrontExtractionResult>;
  extractBack: (buffer: Buffer) => Promise<BackExtractionResult>;
  extractLive: (buffer: Buffer, opts: { isSandbox: boolean; headTurnMetadata?: HeadTurnLivenessMetadata }) => Promise<LiveCaptureResult>;
  faceMatchThreshold: number;
}

/** Pick the flow from the uploads when the caller does not name one. */
export function inferFlow(has: { back: boolean; live: boolean }): StatelessFlow {
  if (has.back && has.live) return 'full';
  if (has.back) return 'document_only';
  return 'identity';
}

/** Uploads the flow needs but the request lacks. */
export function missingUploads(flow: StatelessFlow, has: { front: boolean; back: boolean; live: boolean }): string[] {
  const need = STATELESS_FLOWS[flow];
  return (['front', 'back', 'live'] as const).filter(k => need[k] && !has[k]);
}

const STRIPPED_OCR_KEYS = new Set(['face_embedding', 'speaker_embedding']);

/** OCR fields for the response: no embeddings, raw text only on request. */
function publicOcr(ocr: Record<string, unknown> | undefined, includeRawText: boolean): Record<string, unknown> | null {
  if (!ocr) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ocr)) {
    if (STRIPPED_OCR_KEYS.has(k)) continue;
    if (k === 'raw_text' && !includeRawText) continue;
    out[k] = v;
  }
  return out;
}

function publicBack(back: BackExtractionResult | null, includeRawText: boolean) {
  if (!back) return null;
  const { raw_barcode_data, ...rest } = back as BackExtractionResult & { ocr?: Record<string, unknown> };
  const ocr = (back as { ocr?: Record<string, unknown> }).ocr;
  return {
    ...rest,
    ...(includeRawText ? { raw_barcode_data } : {}),
    ...(ocr ? { ocr: publicOcr(ocr, includeRawText) } : {}),
  };
}

export interface StatelessResult {
  final_result: 'verified' | 'failed' | 'manual_review' | null;
  status: string;
  flow: string;
  rejection: { reason: string; detail: string | null; user_message: string | null } | null;
  document: {
    front: Record<string, unknown> | null;
    back: ReturnType<typeof publicBack>;
  };
  checks: {
    ocr_confidence: number | null;
    authenticity: FrontExtractionResult['authenticity'] | null;
    cross_validation: SessionState['cross_validation'];
    liveness: SessionState['liveness'];
    deepfake_check: SessionState['deepfake_check'];
    face_match: SessionState['face_match'];
    age_estimation: SessionState['age_estimation'];
  };
}

export async function runStatelessVerification(input: StatelessInput, deps: StatelessDeps): Promise<StatelessResult> {
  const documentId = randomUUID(); // correlates the engine call only; never stored
  const session = new VerificationSession(
    {
      extractFront: buffer => deps.extractFront(buffer, {
        documentId, documentType: input.documentType, issuingCountry: input.issuingCountry,
      }),
      extractBack: buffer => deps.extractBack(buffer),
      processLiveCapture: buffer => deps.extractLive(buffer, { isSandbox: false, headTurnMetadata: input.headTurnMetadata }),
      computeFaceMatch,
      faceMatchThreshold: deps.faceMatchThreshold,
    },
    { issuing_country: input.issuingCountry ?? null },
    FLOW_PRESETS[input.flow],
  );

  let last: StepResult = await session.submitFront(input.front);
  // Passports skip the back side even in the full flow (applyPassportOverride)
  if (last.passed && session.getState().current_step === VerificationStatus.AWAITING_BACK) {
    last = await session.submitBack(input.back!);
  }
  if (last.passed && session.getState().current_step === VerificationStatus.AWAITING_LIVE) {
    last = await session.submitLiveCapture(input.live!);
  }

  const state = session.getState();
  const mapped = mapStatusForResponse(state, session.getFlow());
  const includeRawText = input.includeRawText === true;

  return {
    final_result: mapped.final_result as StatelessResult['final_result'],
    status: state.current_step,
    flow: session.getFlow().preset,
    rejection: state.rejection_reason
      ? { reason: state.rejection_reason, detail: state.rejection_detail, user_message: last.user_message }
      : null,
    document: {
      front: publicOcr(state.front_extraction?.ocr as Record<string, unknown> | undefined, includeRawText),
      back: publicBack(state.back_extraction, includeRawText),
    },
    checks: {
      ocr_confidence: state.front_extraction?.ocr_confidence ?? null,
      authenticity: state.front_extraction?.authenticity ?? null,
      cross_validation: state.cross_validation,
      liveness: state.liveness,
      deepfake_check: state.deepfake_check,
      face_match: state.face_match,
      age_estimation: state.age_estimation,
    },
  };
}

/** Overwrite uploaded image bytes once processing is done. */
export function wipe(...buffers: Array<Buffer | undefined>): void {
  for (const b of buffers) b?.fill(0);
}
