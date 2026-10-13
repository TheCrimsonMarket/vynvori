/** Phase 6C UX-C01–07 SOURCE-ALIGNED CANDIDATE ONLY. NOT a deployed contract or authorization implementation. */
export type Brand<T, Tag extends string> = T & { readonly __brand: Tag };
export type ProjectId = Brand<string,'ProjectId'>;
export type DirectionId = Brand<string,'DirectionId'>;
export type VersionId = Brand<string,'VersionId'>;
export type OperationId = Brand<string,'OperationId'>;
export type QuoteId = Brand<string,'QuoteId'>;
export type ReceiptId = Brand<string,'ReceiptId'>;
export type CustomerErrorCode =
 | 'AUTH_REQUIRED' | 'SSO_BRIDGE_UNAVAILABLE' | 'PLAN_NOT_APPROVED' | 'PLAN_STALE'
 | 'QUOTE_STALE' | 'QUOTE_EXPIRED' | 'INSUFFICIENT_CREDITS' | 'CONCEPT_MODEL_UNQUALIFIED'
 | 'STANDARD_FINAL_UNQUALIFIED' | 'DOWNSTREAM_USE_UNAVAILABLE' | 'RIGHTS_INELIGIBLE'
 | 'PROMO_ALREADY_USED' | 'PROVIDER_OUTCOME_UNKNOWN' | 'ARTIFACT_PERSISTENCE_UNCONFIRMED'
 | 'PARTIAL_DELIVERY' | 'QUALITY_CASE_OPEN' | 'REMEDY_REQUIRED' | 'PACKAGE_CLOSURE_PENDING'
 | 'INCLUDED_REFINEMENT_UNAVAILABLE' | 'DRAFT_EXPIRED' | 'CLAIM_CONFLICT' | 'PRINT_PROFILE_UNAPPROVED'
 | 'TERMS_NOT_APPROVED' | 'REGION_CHANGED' | 'RIGHTS_REVOKED' | 'QUOTE_USE_MISMATCH';
export type Capability = 'available'|'unavailable'|'under_review';
export interface AvailabilityV1 {
  readonly atIso: string; readonly capabilitySnapshotId: string; readonly region: string;
  readonly concept:Capability;readonly director:Capability;readonly promo:Capability;
  readonly qualifiedStandardFinal:Capability;readonly qualifiedPremiumFinal:Capability;
  readonly digitalArtExportLicensed:Capability;readonly garmentProductionQualified:Capability;
  readonly rightsSummary:string;readonly customerRestrictions:readonly string[];
}
export interface PlanDirectionV1 {
  readonly directionId:DirectionId; readonly title:string;readonly rationale:string;
  readonly visualIntent:string;readonly risks:readonly string[];
}
export type SlotStatus = 'waiting'|'submitted'|'running'|'artifact_persisting'|'delivered'|'verified_uncharged_failure'|'under_review'|'remedy_required';
export interface ConceptSlotV1 {
  readonly slotNumber:1|2|3;readonly directionId:DirectionId;readonly status:SlotStatus;
  readonly operationId:OperationId|null;readonly persistedVersionId:VersionId|null;readonly publicReceiptId:ReceiptId|null;
}
export type PlanStateV1 =
 | {readonly kind:'unapproved';readonly draftPlanId?:string;readonly conceptSlots:readonly []}
 | {readonly kind:'approved';readonly planVersionId:string;readonly approvalHash:string;readonly directions:readonly [PlanDirectionV1,PlanDirectionV1,PlanDirectionV1];readonly conceptSlots:readonly []}
 | {readonly kind:'bundle_authorized';readonly planVersionId:string;readonly approvalHash:string;readonly directions:readonly [PlanDirectionV1,PlanDirectionV1,PlanDirectionV1];readonly conceptSlots:readonly [ConceptSlotV1,ConceptSlotV1,ConceptSlotV1]};

/** PUBLIC ST-05 plan presentation, independent of authoritative PlanStateV1. */
export type DirectorPlanProjectionV1 =
 | { readonly kind:'draft';readonly draftPlanId:string;readonly planRevision:number;readonly briefVersionId:VersionId;
     readonly directions:readonly [PlanDirectionV1,PlanDirectionV1,PlanDirectionV1];readonly conceptSlots:readonly [];
     readonly approvalHash?:never;readonly planVersionId?:never;readonly approvedPlanRevision?:never;readonly approvedAt?:never; }
 | { readonly kind:'approved';readonly planVersionId:string;readonly approvedPlanRevision:number;readonly briefVersionId:VersionId;
     readonly approvalHash:string;readonly approvedAt:string;
     readonly directions:readonly [PlanDirectionV1,PlanDirectionV1,PlanDirectionV1];readonly conceptSlots:readonly []; };

export type DownstreamKind='digital_art_export'|'personalized_garment';
export type RightsDecision='commercial_use_permitted'|'preview_only'|'not_permitted'|'unverified';
export interface DownstreamUseEligibilityV2 {
  readonly kind:DownstreamKind;
  readonly status:'eligible'|'ineligible'|'under_review';
  readonly region:string;
  readonly rightsDecision:RightsDecision;
  readonly rightsPolicyVersion:string|null;
  readonly restrictions:readonly string[];
  readonly exclusionReasonCodes:readonly CustomerErrorCode[];
  readonly humanSummary:string;
}
export interface DownstreamEligibilityV2 {
  readonly region:string;readonly evaluatedAt:string;
  readonly uses:readonly [
    DownstreamUseEligibilityV2 & {readonly kind:'digital_art_export'},
    DownstreamUseEligibilityV2 & {readonly kind:'personalized_garment'}
  ];
  /** Identifiers of uses actually disclosed as eligible on this quote; never substitute another use on authorization. */
  readonly quotedEligibleUses:readonly DownstreamKind[];
  readonly rightsNoticeVersion:string;
}
export interface CreditWalletSummaryV1 {
  readonly unit:'credits'; readonly availableUnits:number; readonly reservedUnits:number;
  readonly heldForReviewUnits:number;readonly snapshotAt:string;readonly walletRevision:string;
}
export type OfferComponent = 'three_new_concepts'|'two_optional_included_refinements'|'one_optional_intro_preview'|'standard_final_render'|'premium_final_render'|'digital_art_export'|'composition_export'|'personalized_garment'|'printing'|'shipping';
export interface PaidDisclosureTermsV1 {
  readonly customerConsentTermsVersion:string;
  readonly expiryTermsVersion:string;
  readonly partialRemedyTermsVersion:string;
  readonly rightsNoticeVersion:string;
  readonly qualityRemedyTermsVersion:string;
  readonly refinementClosureNoticeVersion:string|null;
  /** Version ids must correspond to approved/published terms at server authorization; mere non-empty strings are insufficient. */
}
export interface ServerAuthorizationHintV1 {
  readonly quoteId:QuoteId;readonly checkedAt:string;
  readonly canAuthorize:boolean;readonly reasonCodes:readonly CustomerErrorCode[];
  readonly quoteVersionId:string;
  /** Public BFF projection only. Authorization is ALWAYS rechecked server-side on POST. */
}
export interface QuoteBaseV3 {
  readonly quoteId:QuoteId;readonly quoteVersionId:string;readonly issuedAt:string;readonly expiresAt:string;
  readonly pricePolicyVersion:string;readonly capabilitySnapshotId:string;
  readonly creditsQuoted:number;readonly maxHoldUnits:number;
  readonly wallet:CreditWalletSummaryV1;readonly consentTextVersion:string;
  readonly included:readonly OfferComponent[];readonly excluded:readonly OfferComponent[];
  readonly authorizationHint:ServerAuthorizationHintV1;
}
export type QuoteViewV3 =
 | (QuoteBaseV3 & {readonly offerKind:'concept_bundle_3x2';readonly projectId:ProjectId;
     readonly approvedPlanVersionId:string;readonly directionIds:readonly [DirectionId,DirectionId,DirectionId];
     readonly includedRefinements:2;readonly finalRenderIncludedInThisPurchase:false;
     readonly physicalGarmentIncluded:false;readonly downstreamEligibility:DownstreamEligibilityV2;
     readonly standardFinalQualified:true;readonly promoOffsetCredits:0;
     readonly paidTerms:PaidDisclosureTermsV1;})
 | (QuoteBaseV3 & {readonly offerKind:'promo_single_preview';readonly directionId:DirectionId;
     readonly finalRenderIncludedInThisPurchase:false;readonly physicalGarmentIncluded:false;
     readonly creditsQuoted:0;readonly maxHoldUnits:0;})
 | (QuoteBaseV3 & {readonly offerKind:'final_standard'|'final_premium';readonly sourceVersionId:VersionId;
     readonly modelQualificationSnapshotId:string;readonly finalRenderIncludedInThisPurchase:true;
     readonly physicalGarmentIncluded:false;readonly paidTerms:PaidDisclosureTermsV1;});

export type CustomerLedgerReceiptV1 =
 | {readonly kind:'not_authorized';readonly quoteId?:QuoteId}
 | {readonly kind:'reserved';readonly quoteId:QuoteId;readonly operationId:OperationId;readonly receiptId:ReceiptId;readonly heldUnits:number;readonly settledUnits:0}
 | {readonly kind:'settled';readonly quoteId:QuoteId;readonly operationId:OperationId;readonly receiptId:ReceiptId;readonly heldUnits:0;readonly settledUnits:number}
 | {readonly kind:'released';readonly quoteId:QuoteId;readonly operationId:OperationId;readonly receiptId:ReceiptId;readonly releasedUnits:number;readonly heldUnits:0}
 | {readonly kind:'under_review';readonly quoteId:QuoteId;readonly operationId:OperationId;readonly receiptId:ReceiptId;readonly heldUnits:number;readonly caseId:string};
export type PublicOperationV3 =
 | {readonly state:'queued'|'running'|'artifact_persisting';readonly operationId:OperationId;readonly receipt:CustomerLedgerReceiptV1;readonly progressPercent?:never}
 | {readonly state:'delivered';readonly operationId:OperationId;readonly persistedVersionId:VersionId;readonly receipt:CustomerLedgerReceiptV1}
 | {readonly state:'under_review'|'remedy_required';readonly operationId:OperationId;readonly caseId:string;readonly receipt:CustomerLedgerReceiptV1}
 | {readonly state:'verified_uncharged_failure';readonly operationId:OperationId;readonly receipt:CustomerLedgerReceiptV1};
/** INTERNAL ONLY. Must not be included in a customer-facing response, mock fixture, or exported StudioScreen. */
export type ProviderExecutionInternalV1 =
 | {readonly status:'prepared';readonly operationId:OperationId;readonly providerJobId:null}
 | {readonly status:'submitted'|'running'|'outcome_unknown';readonly operationId:OperationId;readonly providerJobId:string|null;readonly vendorCostEvidence:'none'|'usage'|'invoice'|'unknown'}
 | {readonly status:'result_received'|'artifact_persisting'|'persistence_failed_under_review'|'persisted_delivered'|'verified_zero_charge_failure';readonly operationId:OperationId;readonly providerJobId:string|null;readonly vendorCostEvidence:'none'|'usage'|'invoice'|'unknown';readonly privateVendorCostUsd?:number};

export interface CustomerBundleFinancialSummaryV1 {
  readonly packageId:string;readonly quoteId:QuoteId;readonly quotedTotalUnits:number;
  readonly maximumAuthorizedHoldUnits:number;readonly currentlyReservedUnits:number;
  readonly currentlyHeldForReviewUnits:number;readonly cumulativelySettledUnits:number;
  readonly cumulativelyReleasedUnits:number;readonly receiptIds:readonly ReceiptId[];
  readonly supportCaseIds:readonly string[];readonly recordedAt:string;
  /** This is a ledger-derived projection. Current and cumulative fields MUST NOT be naively summed. */
}
export type RefinementSlotV1 =
 | {readonly state:'available'|'skipped';readonly ordinal:1|2;readonly packageId:string;readonly sourceVersionId:VersionId|null}
 | {readonly state:'pending'|'unknown';readonly ordinal:1|2;readonly packageId:string;readonly sourceVersionId:VersionId;readonly operationId:OperationId}
 | {readonly state:'used';readonly ordinal:1|2;readonly packageId:string;readonly sourceVersionId:VersionId;readonly deliveredVersionId:VersionId;readonly operationId:OperationId}
 | {readonly state:'forfeited';readonly ordinal:1|2;readonly packageId:string;readonly closureCause:'final_delivered'|'explicit_close'|'approved_expiry'};
export type PackageStateV1='quoted'|'authorized'|'partial'|'delivered_3_of_3'|'refinements_open'|'closure_pending'|'closed'|'remedy_pending';
export type SafeActionV1='approve_plan'|'inspect_quote'|'authorize_promo'|'authorize_bundle'|'view_partial'|'select_concept'|'skip_refinement'|'restore_refinement'|'authorize_refinement'|'inspect_final_quote'|'authorize_final'|'use_version'|'save_version'|'request_quoted_revision'|'report_quality'|'open_support'|'resume';
export interface CreativeBriefDisplayV1 {
  readonly briefId:string;readonly revision:number;readonly entryMode:'guided'|'free';readonly summary:string;
  readonly exactText:readonly string[];readonly referenceCount:number;readonly rightsAcknowledged:boolean;
}
export interface ConceptCardV1 {
  readonly slotNumber:1|2|3;readonly directionId:DirectionId;readonly directionTitle:string;
  readonly status:SlotStatus;readonly versionId:VersionId|null;
  readonly safePreviewUrl:string|null;readonly accessibleDescription:string;
  readonly operation:PublicOperationV3|null;readonly receiptId:ReceiptId|null;
  readonly sourceRightsSummary:string;readonly isSelected:boolean;
}
export interface StudioVersionHistoryItemV1 {
  readonly versionId:VersionId;readonly parentVersionId:VersionId|null;
  readonly kind:'concept'|'promo_preview'|'refinement'|'final';readonly label:string;
  readonly createdAt:string;readonly saved:boolean;readonly rightsSummary:string;
  readonly previewUrl:string|null;
}
export interface PromoEligibilityViewV1 {
  readonly state:'eligible'|'already_used'|'ineligible'|'unavailable'|'under_review';
  readonly explanatoryText:string;readonly chosenDirectionId:DirectionId|null;
}
export interface SupportCaseViewV1 {
  readonly caseId:string;readonly kind:'financial_reconciliation'|'quality_issue'|'lost_capability'|'partial_bundle';
  readonly state:'open'|'under_review'|'remedy_pending'|'resolved';readonly publicMessage:string;
}
export interface StudioStatusV3 {
  readonly schemaVersion:'studio-status.v3';readonly projectId:ProjectId;
  readonly plan:PlanStateV1;readonly deliveredConceptCount:0|1|2|3;
  readonly packageState:PackageStateV1|null;readonly promoStatus:'eligible'|'unavailable'|'claimed'|'under_review';
  readonly customerOperations:readonly PublicOperationV3[];
  readonly bundleFinancials:CustomerBundleFinancialSummaryV1|null;
  readonly capabilities:AvailabilityV1;readonly allowedActions:readonly SafeActionV1[];
  readonly currentErrorCode:CustomerErrorCode|null;
  readonly refinements:readonly [RefinementSlotV1,RefinementSlotV1]|readonly [];
}
export type StudioStageV1 =
 'entry'|'guided_brief'|'free_brief'|'brief_review'|'director_planning'|'director_review'|'offer_choice'|'promo_review'|
 'concept_quote'|'concepts_running'|'concepts_partial'|'concepts_review'|'refinement_1'|'refinement_2'|'final_quote'|'final_unavailable'|'final_review'|'history';
import type { StudioRecoveryProjectionV1 } from './vynvori-phase6e-companion.proposed.js';
export interface StudioScreenBaseV1 {
  readonly schemaVersion:'studio-screen.v1';readonly route:string;readonly projectId:ProjectId|null;
  readonly status:StudioStatusV3|null;readonly availableActions:readonly SafeActionV1[];
  readonly errorCode:CustomerErrorCode|null;readonly supportCases:readonly SupportCaseViewV1[];
  readonly history:readonly StudioVersionHistoryItemV1[];
  readonly recovery?:StudioRecoveryProjectionV1|null; // stage-specific, public-safe projection; server validates association
}
export type StudioScreenV1 = StudioScreenBaseV1 & (
 | {readonly screenId:'ST-00';readonly stage:'entry';readonly entryModes:readonly ['guide_me','create_freely'];readonly byoLink:'/customize'}
 | {readonly screenId:'ST-01';readonly stage:'guided_brief';readonly brief:CreativeBriefDisplayV1|null}
 | {readonly screenId:'ST-02';readonly stage:'free_brief';readonly brief:CreativeBriefDisplayV1|null}
 | {readonly screenId:'ST-03';readonly stage:'brief_review';readonly brief:CreativeBriefDisplayV1;readonly guestClaimStatus:'guest'|'sign_in_required'|'claim_pending'|'claimed'|'expired'|'conflict'}
 | {readonly screenId:'ST-04';readonly stage:'director_planning';readonly brief:CreativeBriefDisplayV1;readonly plannerJobId:string}
 | {readonly screenId:'ST-05';readonly stage:'director_review';readonly plan:DirectorPlanProjectionV1}
 | {readonly screenId:'ST-06';readonly stage:'offer_choice';readonly promo:PromoEligibilityViewV1;readonly offerDisclosures:readonly string[]}
 | {readonly screenId:'ST-07';readonly stage:'promo_review';readonly promo:PromoEligibilityViewV1;readonly promoOperation:PublicOperationV3|null}
 | {readonly screenId:'ST-08';readonly stage:'concept_quote';readonly quote:Extract<QuoteViewV3,{offerKind:'concept_bundle_3x2'}>|null}
 | {readonly screenId:'ST-09';readonly stage:'concepts_running';readonly conceptCards:readonly [ConceptCardV1,ConceptCardV1,ConceptCardV1];readonly bundleFinancials:CustomerBundleFinancialSummaryV1}
 | {readonly screenId:'ST-10';readonly stage:'concepts_partial';readonly conceptCards:readonly [ConceptCardV1,ConceptCardV1,ConceptCardV1];readonly bundleFinancials:CustomerBundleFinancialSummaryV1}
 | {readonly screenId:'ST-11';readonly stage:'concepts_review';readonly conceptCards:readonly [ConceptCardV1,ConceptCardV1,ConceptCardV1];readonly bundleFinancials:CustomerBundleFinancialSummaryV1}
 | {readonly screenId:'ST-12';readonly stage:'refinement_1';readonly slot:RefinementSlotV1;readonly sourceVersionId:VersionId}
 | {readonly screenId:'ST-13';readonly stage:'refinement_2';readonly slot:RefinementSlotV1;readonly sourceVersionId:VersionId}
 | {readonly screenId:'ST-14';readonly stage:'final_quote';readonly quote:Extract<QuoteViewV3,{offerKind:'final_standard'|'final_premium'}>|null}
 | {readonly screenId:'ST-15';readonly stage:'final_unavailable';readonly reasonCodes:readonly CustomerErrorCode[];readonly savedVersions:readonly StudioVersionHistoryItemV1[]}
 | {readonly screenId:'ST-16';readonly stage:'final_review';readonly finalOperation:PublicOperationV3;readonly finalVersionId:VersionId|null}
 | {readonly screenId:'ST-17';readonly stage:'history';readonly savedVersions:readonly StudioVersionHistoryItemV1[]}
);
export type StudioCommandV1 =
 | {readonly action:'inspect_quote';readonly projectId:ProjectId}
 | {readonly action:'authorize_bundle';readonly projectId:ProjectId;readonly quoteId:QuoteId;readonly expectedRevision:number;readonly consentId:string;readonly idempotencyKey:string}
 | {readonly action:'use_version';readonly projectId:ProjectId;readonly versionId:VersionId;readonly expectedRevision:number;readonly idempotencyKey:string}
 | {readonly action:'report_quality';readonly projectId:ProjectId;readonly versionId:VersionId;readonly description:string;readonly idempotencyKey:string}
 | {readonly action:'resume';readonly projectId:ProjectId};
export type StudioCommandResultV1 =
 | {readonly kind:'accepted';readonly projectRevision:number;readonly screen:StudioScreenV1}
 | {readonly kind:'pending';readonly operationId:OperationId;readonly screen:StudioScreenV1}
 | {readonly kind:'rejected';readonly errorCode:CustomerErrorCode;readonly message:string;readonly currentScreen:StudioScreenV1};
export type ImageAssetKindV1='customer_original'|'provider_original'|'derived_preview'|'garment_mockup'|'digital_export'|'print_master'|'qa_proof';
export interface AssetLineageV1 {readonly assetId:string;readonly kind:ImageAssetKindV1;readonly sourceHashes:readonly string[];readonly sha256:string;readonly rightsPolicyVersion:string;readonly ownerId:string;readonly rendererVersion?:string;readonly printProfileVersion?:string;}
export type ProductionJobStateV1='pending_asset_verification'|'preflight_pending'|'preflight_blocked'|'awaiting_human_qa'|'needs_customer_reapproval'|'approved_for_print'|'released_to_partner'|'printing'|'printed'|'packed'|'awaiting_dispatch'|'shipped'|'delivered'|'cancelled_before_release'|'production_exception';

/** Shallow demo-only shape checks — NEVER authorization. Implement strict Zod/equivalent schemas on the BFF before real Design 1.1 acceptance. */
const plain=(x:unknown):x is Record<string,unknown> => typeof x==='object' && x!==null && !Array.isArray(x);
const natural=(x:unknown):x is number => typeof x==='number' && Number.isSafeInteger(x) && x>=0;
const nonempty=(x:unknown):x is string => typeof x==='string' && x.length>0;
export function hasCompleteDirectionMapping(d:readonly DirectionId[]):boolean {return d.length===3 && new Set(d).size===3 && d.every(nonempty);}
export function validateQuoteMockShape(raw:unknown):{valid:boolean;errors:readonly string[]} {
  const e:string[]=[];
  if(!plain(raw))return{valid:false,errors:['not_object']};
  if(!['concept_bundle_3x2','promo_single_preview','final_standard','final_premium'].includes(String(raw.offerKind)))e.push('offer_kind');
  for(const k of ['quoteId','quoteVersionId','pricePolicyVersion','capabilitySnapshotId','issuedAt','expiresAt','consentTextVersion'])if(!nonempty(raw[k]))e.push(k);
  for(const k of ['creditsQuoted','maxHoldUnits'])if(!natural(raw[k]))e.push(k);
  if(!plain(raw.wallet)||!['availableUnits','reservedUnits','heldForReviewUnits'].every(k=>natural((raw.wallet as Record<string,unknown>)[k])))e.push('wallet');
  if(!plain(raw.authorizationHint)||!nonempty(raw.authorizationHint.quoteId)||raw.authorizationHint.quoteId!==raw.quoteId || typeof raw.authorizationHint.canAuthorize!=='boolean'||!Array.isArray(raw.authorizationHint.reasonCodes))e.push('authorization_hint');
  if(!Array.isArray(raw.included)||!Array.isArray(raw.excluded))e.push('inclusions');
  if(raw.offerKind==='concept_bundle_3x2'){
    if(!Array.isArray(raw.directionIds)||!hasCompleteDirectionMapping(raw.directionIds))e.push('directions');
    if(!plain(raw.downstreamEligibility))e.push('downstream_eligibility');
    else{
      const u=raw.downstreamEligibility.uses;
      const eligible=raw.downstreamEligibility.quotedEligibleUses;
      if(!Array.isArray(u)||u.length!==2 || u[0]?.kind!=='digital_art_export'||u[1]?.kind!=='personalized_garment'||!Array.isArray(eligible)||eligible.length<1||eligible.some((k:unknown)=>!u.some((x:DownstreamUseEligibilityV2)=>x.kind===k&&x.status==='eligible'&&x.rightsDecision==='commercial_use_permitted')))e.push('quoted_eligible_use');
    }
    if(!plain(raw.paidTerms)||!['customerConsentTermsVersion','expiryTermsVersion','partialRemedyTermsVersion','rightsNoticeVersion','qualityRemedyTermsVersion'].every(k=>nonempty((raw.paidTerms as Record<string,unknown>)[k])))e.push('required_terms');
    if(raw.finalRenderIncludedInThisPurchase!==false||raw.physicalGarmentIncluded!==false)e.push('offer_flags');
  }
  return {valid:e.length===0,errors:e};
}
/** There is deliberately NO client canAuthorizeConceptQuote helper. Only a fresh BFF mutation may authorize. */

/** Mock-only runtime projection shape checks; production needs strict schema parsing, authenticated actor and server authorization. */
export function validateStudioScreenMockShape(raw:unknown):{valid:boolean;errors:readonly string[]}{
  const errors:string[]=[];
  if(!plain(raw))return {valid:false,errors:['not_object']};
  const stages:Record<string,StudioStageV1>={
    'ST-00':'entry','ST-01':'guided_brief','ST-02':'free_brief','ST-03':'brief_review',
    'ST-04':'director_planning','ST-05':'director_review','ST-06':'offer_choice','ST-07':'promo_review',
    'ST-08':'concept_quote','ST-09':'concepts_running','ST-10':'concepts_partial','ST-11':'concepts_review',
    'ST-12':'refinement_1','ST-13':'refinement_2','ST-14':'final_quote','ST-15':'final_unavailable',
    'ST-16':'final_review','ST-17':'history'
  };
  if(raw.schemaVersion!=='studio-screen.v1')errors.push('schema_version');
  if(!nonempty(raw.screenId)||!nonempty(raw.stage)||stages[raw.screenId]!==raw.stage)errors.push('screen_stage_mismatch');
  if(!nonempty(raw.route)||!Array.isArray(raw.availableActions)||!Array.isArray(raw.history)||!Array.isArray(raw.supportCases))errors.push('screen_base');
  if(['ST-09','ST-10','ST-11'].includes(String(raw.screenId))){
    if(!Array.isArray(raw.conceptCards)||raw.conceptCards.length!==3||!raw.conceptCards.every((c:unknown)=>plain(c)&&natural(c.slotNumber)&&nonempty(c.directionId)&&typeof c.accessibleDescription==='string'))errors.push('concept_cards');
    if(!plain(raw.bundleFinancials)||!natural(raw.bundleFinancials.quotedTotalUnits)||!natural(raw.bundleFinancials.currentlyReservedUnits)||!natural(raw.bundleFinancials.currentlyHeldForReviewUnits)||!natural(raw.bundleFinancials.cumulativelySettledUnits)||!natural(raw.bundleFinancials.cumulativelyReleasedUnits))errors.push('bundle_financials');
  }
  if(raw.screenId==='ST-08'&&raw.quote!==null){
    const quoteValidation=validateQuoteMockShape(raw.quote);
    if(!quoteValidation.valid||!plain(raw.quote)||raw.quote.offerKind!=='concept_bundle_3x2')errors.push('concept_quote');
  }
  if(raw.screenId==='ST-00'&&raw.byoLink!=='/customize')errors.push('byo_link');
  const leakKeys=['providerJobId','privateVendorCostUsd','vendorCostEvidence','internalInvoice','staffNotes'];
  function scan(obj:unknown,depth:number):void{
    if(depth>20)return;
    if(Array.isArray(obj)){for(const v of obj)scan(v,depth+1);return;}
    if(!plain(obj))return;
    for(const [k,v] of Object.entries(obj)){
      if(leakKeys.includes(k))errors.push('internal_provider_field');
      scan(v,depth+1);
    }
  }
  scan(raw,0);
  return {valid:errors.length===0,errors};
}
