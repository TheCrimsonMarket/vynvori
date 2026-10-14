/** PROPOSED PHASE 6E DELTA. Types only. No backend APIs or production validators exist. */
import type {
  ProjectId, VersionId, OperationId, QuoteId, ReceiptId,
  CreditWalletSummaryV1, CustomerErrorCode, PublicOperationV3
} from './vynvori-v1_1-proposed.js';

type IsoDate = string;      // enforce ISO 8601 at runtime
export type HashSha256 = string;  // enforce 64 lowercase hex at runtime
export type PublicAction = 'inspect'|'edit_new_version'|'freeze'|'request_preflight'|'quote'|'add_to_cart'|
  'sign_in'|'claim_draft'|'view_orders'|'view_wallet'|'request_download'|'open_support_case'|'go_back';
export interface CompositionIdentityV1 {
  readonly compositionId:string;
  readonly compositionVersionId:VersionId;
  readonly sceneHashSha256:HashSha256;
  readonly variantId:string;
  readonly printProfileVersion:string;
}
export interface ScopedArtifactV1 {
  readonly artifactId:string;
  readonly artifactSha256:HashSha256;
  readonly sourceCompositionVersionId:VersionId;
  readonly sourceSceneSha256:HashSha256;
  readonly status:'pending'|'ready'|'under_review'|'unavailable';
  /** No permanent public/private R2 object key or unscoped download URL */
}
export interface SnapshotValidationV1 {
  readonly validationId:string;
  readonly sourceCompositionVersionId:VersionId;
  readonly sourceSceneSha256:HashSha256;
  readonly state:'preview_only'|'blocked'|'passed_pending_human_qa';
  readonly issueCodes:readonly string[];
  readonly rightsSnapshotId:string;
  readonly printProfileVersion:string;
}
export interface GarmentCartQuoteV1 extends CompositionIdentityV1 {
  readonly quoteId:QuoteId;
  readonly quoteVersion:string;
  readonly expiresAt:IsoDate;
  readonly currency:string;
  readonly totalMinorUnits:number;
  readonly rightsSnapshotId:string;
  readonly preflightValidationId:string;
  readonly shippingDisclosureStatus:'unverified'|'verified_for_region'|'unavailable';
  readonly eligibleForCart:boolean; // BFF display only; never grants checkout authorization
}
export interface CompositionReviewProjectionV1 {
  readonly screenId:'ED-03';
  readonly identity:CompositionIdentityV1;
  readonly displayedProof:ScopedArtifactV1|null;
  readonly validation:SnapshotValidationV1|null;
  readonly cartQuote:GarmentCartQuoteV1|null;
  readonly newUnfrozenEditsExist:boolean;
  readonly allowedActions:readonly PublicAction[];
}
export interface PhysicalLayerGeometryV1 {
  readonly xMm:number;readonly yMm:number;readonly widthMm:number;readonly heightMm:number;
  readonly rotationDeg:number;readonly zIndex:number;readonly visible:boolean;
}
export type EditorLayerV1 =
 | ({readonly kind:'image';readonly layerId:string;readonly sourceAssetId:string;readonly sourceAssetSha256:HashSha256;} & PhysicalLayerGeometryV1)
 | ({readonly kind:'text';readonly layerId:string;readonly text:string;readonly fontAssetId:string;
    readonly fontFileSha256:HashSha256;readonly fontLicenseVersion:string;readonly fontSizePt:number;
    readonly color:string;} & PhysicalLayerGeometryV1);
export interface EditorPageV1 {readonly zoneId:string;readonly layers:readonly EditorLayerV1[];}
export interface EditorDraftProjectionV1 {
  readonly schemaVersion:'editor-draft.v1';
  readonly compositionId:string;readonly draftRevision:number;
  readonly ownerKind:'guest_capability'|'authenticated_owner';
  readonly pages:readonly EditorPageV1[];
  readonly selectedZoneId:string;
  readonly hasUnfrozenChanges:boolean;
  readonly canPersistToAccount:boolean;
}
export type EditorScreenV1 =
 | {readonly schemaVersion:'editor-screen.v1';readonly screenId:'ED-01';readonly route:'/customize';readonly guestPermitted:true;
    readonly entrySource:'direct_byo'|'studio_transfer';readonly draft:EditorDraftProjectionV1|null;
    readonly actions:readonly PublicAction[];}
 | {readonly schemaVersion:'editor-screen.v1';readonly screenId:'ED-02';readonly route:string;
    readonly draft:EditorDraftProjectionV1;readonly frozenVersions:readonly CompositionIdentityV1[];
    readonly autosave:'idle'|'pending'|'conflict'|'failed';readonly actions:readonly PublicAction[];}
 | ({readonly schemaVersion:'editor-screen.v1';readonly route:string} & CompositionReviewProjectionV1);

/** Uploaded customer's unchanged original bytes are NOT a purchased export entitlement. */
export type DigitalExportKindV1='artwork_export'|'composition_export';
/** INTERNAL entitlement binding includes authoritative payment evidence; not a public payload. */
export type DigitalExportEntitlementV1 =
 | {readonly status:'paid_pending_artifact'|'under_review'|'revoked'|'refunded';
    readonly entitlementId:string;readonly ownerId:string;readonly kind:DigitalExportKindV1;
    readonly sourceVersionId:VersionId;readonly sourceVersionSha256:HashSha256;
    readonly medusaOrderLineId:string;readonly verifiedCaptureId:string;
    readonly rightsPolicyVersion:string;readonly termsVersion:string;
    readonly artifactId:null;readonly artifactSha256:null;readonly exportProfileVersion:string;}
 | {readonly status:'ready';readonly entitlementId:string;readonly ownerId:string;readonly kind:DigitalExportKindV1;
    readonly sourceVersionId:VersionId;readonly sourceVersionSha256:HashSha256;
    readonly medusaOrderLineId:string;readonly verifiedCaptureId:string;
    readonly rightsPolicyVersion:string;readonly termsVersion:string;
    readonly artifactId:string;readonly artifactSha256:HashSha256;readonly exportProfileVersion:string;};

/** Distributive public allowlist: payment capture identifiers stay internal. */
export type CustomerDigitalExportEntitlementV1 = DigitalExportEntitlementV1 extends infer E
  ? E extends DigitalExportEntitlementV1 ? Omit<E,'verifiedCaptureId'> : never : never;
export interface CustomerSafeExportViewV1 {
  readonly entitlement:CustomerDigitalExportEntitlementV1;
  readonly downloadEligibility:'available'|'temporarily_unavailable'|'not_permitted';
  readonly downloadRoute:string|null; // owner-authenticated endpoint, NOT a permanent R2 URL
  readonly reasonCodes:readonly CustomerErrorCode[];
}
export type AccountScreenV1 =
 | {readonly schemaVersion:'account-screen.v1';readonly screenId:'AC-01';readonly view:'exports';
    readonly ownerId:string;readonly exports:readonly CustomerSafeExportViewV1[];
    readonly actions:readonly PublicAction[];}
 | {readonly schemaVersion:'account-screen.v1';readonly screenId:'AC-01';readonly view:'credits';
    readonly wallet:CreditWalletSummaryV1;readonly receiptIds:readonly ReceiptId[];
    readonly supportCaseIds:readonly string[];readonly actions:readonly PublicAction[];}
 | {readonly schemaVersion:'account-screen.v1';readonly screenId:'AC-01';readonly view:'projects'|'orders';
    readonly ownerId:string;readonly recordRefs:readonly string[];readonly actions:readonly PublicAction[];};
export interface PersonalizedMedusaLineViewV1 extends CompositionIdentityV1 {
  readonly medusaLineId:string;readonly quantity:number;readonly quoteId:QuoteId;
  readonly preflightValidationId:string;readonly sourceProofArtifactId:string;
  readonly lineTotalMinorUnits:number;readonly currency:string;
}
export type CommerceScreenV1 =
 | {readonly schemaVersion:'commerce-screen.v1';readonly screenId:'CO-01';readonly state:'empty';
    readonly route:'/cart';readonly lines:readonly [];readonly actions:readonly PublicAction[];}
 | {readonly schemaVersion:'commerce-screen.v1';readonly screenId:'CO-01';readonly state:'cart_review'|'checkout_blocked'|'checkout_ready'|'payment_pending'|'payment_under_review';
    readonly route:'/cart'|'/checkout';readonly medusaCartId:string;
    readonly lines:readonly PersonalizedMedusaLineViewV1[];
    readonly verifiedRegion:string|null;readonly shippingStatus:'not_quoted'|'verified'|'not_serviceable';
    readonly paymentStatus:'uninitiated'|'pending'|'captured'|'failed'|'under_review';
    readonly errorCodes:readonly string[];readonly actions:readonly PublicAction[];};

/** Customer-safe recovery. May not encode private provider invoices or model-cost evidence. */
export type StudioRecoveryProjectionV1 =
 | {readonly kind:'director_quota_reached';readonly projectId:ProjectId;readonly savedBriefVersionId:VersionId;
    readonly canStartDirector:false;readonly retryEligibleAtIso:string|null;readonly customerMessage:string;}
 | {readonly kind:'concept_route_unavailable';readonly projectId:ProjectId;
    readonly packageId:string|null;readonly phase:'before_authorization'|'after_authorization';
    readonly supportCaseId:string|null;readonly mayStartPaidConcepts:false;readonly customerMessage:string;}
 | {readonly kind:'promo_artifact_persistence_under_review';readonly projectId:ProjectId;
    readonly operationId:OperationId;readonly claimState:'held_for_reconciliation';
    readonly supportCaseId:string|null;readonly canClaimAnotherPromo:false;readonly customerMessage:string;}
 | {readonly kind:'final_verified_uncharged_failure';
    readonly attemptKind:'initial_final_before_original_closure';
    readonly projectId:ProjectId;readonly originalPackageId:string;
    readonly preAttemptOriginalPackageClosure:'open';readonly originalPackageClosure:'open';
    readonly operationId:OperationId;readonly originalQuoteId:QuoteId;
    readonly releaseReceiptId:ReceiptId;
    readonly previouslyDeliveredFinalVersionId:null;
    readonly unusedOriginalRefinements:'preserve_pre_attempt_eligibility';
    readonly retryRequiresNewAuthorization:true;readonly customerMessage:string;}
 | {readonly kind:'final_verified_uncharged_failure';
    readonly attemptKind:'separately_purchased_revision_after_original_closure';
    readonly projectId:ProjectId;readonly originalPackageId:string;
    readonly preAttemptOriginalPackageClosure:'closed';readonly originalPackageClosure:'closed';
    readonly operationId:OperationId;readonly originalQuoteId:QuoteId;
    readonly releaseReceiptId:ReceiptId;
    readonly previouslyDeliveredFinalVersionId:VersionId;
    readonly unusedOriginalRefinements:'remain_closed_no_restoration';
    readonly retryRequiresNewAuthorization:true;readonly customerMessage:string;}
 | {readonly kind:'final_unresolved';readonly projectId:ProjectId;readonly originalPackageId:string;
    readonly operation:PublicOperationV3;readonly customerMessage:string;
    readonly preAttemptOriginalPackageClosure:'open';readonly closureState:'pending';
    readonly previouslyDeliveredFinalVersionId:null;}
 | {readonly kind:'final_unresolved';readonly projectId:ProjectId;readonly originalPackageId:string;
    readonly operation:PublicOperationV3;readonly customerMessage:string;
    readonly preAttemptOriginalPackageClosure:'closed';readonly closureState:'closed';
    readonly previouslyDeliveredFinalVersionId:VersionId;};

/** F-R04 Option A founder-approved POLICY. Live grant/authorization remains BLOCKED
 * until approved numeric SLA, remedy caps, roles, notices/consent and consumer-law checks. */
export type RemedyKindV1='replacement_service'|'credit_adjustment'|'monetary_refund';
export type InternalRemedyAuthorizationCommandV1 =
 | {readonly commandType:'authorize_case_remedy';readonly caseId:string;
    readonly originalPackageId:string;readonly originalFinalVersionId:VersionId;
    readonly customerId:string;readonly remedyDecisionId:string;
    readonly idempotencyScope:string;readonly idempotencyKey:string;
    readonly expectedCaseRevision:number;readonly disposition:'upheld';
    readonly authorizingStaffActorId:string;readonly staffAuthorizationEvidenceId:string;
    readonly approvedRemedyPolicyVersion:string;readonly approvedOperationalTermsVersion:string;
    readonly customerNoticePlanId:string;readonly customerConsentId:string|null;
    readonly remedyKind:'replacement_service';readonly replacementSourceVersionId:VersionId;
    readonly replacementSourceSha256:HashSha256;}
 | {readonly commandType:'authorize_case_remedy';readonly caseId:string;
    readonly originalPackageId:string;readonly originalFinalVersionId:VersionId;
    readonly customerId:string;readonly remedyDecisionId:string;
    readonly idempotencyScope:string;readonly idempotencyKey:string;
    readonly expectedCaseRevision:number;readonly disposition:'upheld';
    readonly authorizingStaffActorId:string;readonly staffAuthorizationEvidenceId:string;
    readonly approvedRemedyPolicyVersion:string;readonly approvedOperationalTermsVersion:string;
    readonly customerNoticePlanId:string;readonly customerConsentId:string|null;
    readonly remedyKind:'credit_adjustment';readonly creditUnits:number;}
 | {readonly commandType:'authorize_case_remedy';readonly caseId:string;
    readonly originalPackageId:string;readonly originalFinalVersionId:VersionId;
    readonly customerId:string;readonly remedyDecisionId:string;
    readonly idempotencyScope:string;readonly idempotencyKey:string;
    readonly expectedCaseRevision:number;readonly disposition:'upheld';
    readonly authorizingStaffActorId:string;readonly staffAuthorizationEvidenceId:string;
    readonly approvedRemedyPolicyVersion:string;readonly approvedOperationalTermsVersion:string;
    readonly customerNoticePlanId:string;readonly customerConsentId:string|null;
    readonly remedyKind:'monetary_refund';readonly medusaOrderLineId:string;
    readonly refundAmountMinorUnits:number;readonly refundCurrency:string;};

/** INTERNAL ONLY. Never serialize through public read-model routes. */
export type RemedyExecutionInternalV1 =
 | {readonly status:'authorized'|'executing'|'reconciling';
    readonly caseId:string;readonly remedyDecisionId:string;readonly authorizationId:string;
    readonly idempotencyScope:string;readonly idempotencyKey:string;
    readonly authorizingStaffActorId:string;readonly originalPackageId:string;
    readonly originalPackageRemainsClosed:true;readonly remedyKind:RemedyKindV1;
    readonly internalAuditRecordId:string;}
 | {readonly status:'completed';readonly caseId:string;readonly remedyDecisionId:string;
    readonly authorizationId:string;readonly idempotencyScope:string;readonly idempotencyKey:string;
    readonly authorizingStaffActorId:string;readonly originalPackageId:string;
    readonly originalPackageRemainsClosed:true;readonly remedyKind:'replacement_service';
    readonly replacementEntitlementId:string;readonly internalAuditRecordId:string;}
 | {readonly status:'completed';readonly caseId:string;readonly remedyDecisionId:string;
    readonly authorizationId:string;readonly idempotencyScope:string;readonly idempotencyKey:string;
    readonly authorizingStaffActorId:string;readonly originalPackageId:string;
    readonly originalPackageRemainsClosed:true;readonly remedyKind:'credit_adjustment';
    readonly privateLedgerAdjustmentId:string;readonly internalAuditRecordId:string;}
 | {readonly status:'completed';readonly caseId:string;readonly remedyDecisionId:string;
    readonly authorizationId:string;readonly idempotencyScope:string;readonly idempotencyKey:string;
    readonly authorizingStaffActorId:string;readonly originalPackageId:string;
    readonly originalPackageRemainsClosed:true;readonly remedyKind:'monetary_refund';
    readonly medusaRefundId:string;readonly internalAuditRecordId:string;};

/** PUBLIC ALLOWLIST: safe case progress only. Excludes actor IDs, private ledger/
 * Medusa refund identifiers, idempotency keys, approval evidence and provider cost. */
export type CustomerRemedyStatusV1 =
 | {readonly schemaVersion:'customer-remedy-status.v1';readonly caseReference:string;
    readonly state:'case_open'|'under_review'|'awaiting_customer_consent'|'not_upheld';
    readonly remedyKind:null;readonly publicRemedyReference:null;
    readonly originalPackageRemainsClosed:true;readonly explanation:string;
    readonly customerNoticeStatus:'not_sent'|'sent'|'delivery_pending';}
 | {readonly schemaVersion:'customer-remedy-status.v1';readonly caseReference:string;
    readonly state:'approved'|'in_progress'|'completed'|'remedy_under_reconciliation';
    readonly remedyKind:RemedyKindV1;readonly publicRemedyReference:string|null;
    readonly originalPackageRemainsClosed:true;readonly explanation:string;
    readonly customerNoticeStatus:'not_sent'|'sent'|'delivery_pending';};
