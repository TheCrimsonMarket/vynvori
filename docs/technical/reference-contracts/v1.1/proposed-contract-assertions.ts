import {hasCompleteDirectionMapping,validateQuoteMockShape} from './vynvori-v1_1-proposed';
import type {QuoteViewV3,AvailabilityV1,ProjectId,DirectionId,QuoteId} from './vynvori-v1_1-proposed';
const dir=['d1','d2','d3'] as unknown as readonly [DirectionId,DirectionId,DirectionId];
const quote: Extract<QuoteViewV3,{offerKind:'concept_bundle_3x2'}> = {
  offerKind:'concept_bundle_3x2',quoteId:'quote1' as QuoteId,quoteVersionId:'v3',issuedAt:'2026-10-13T00:00:00Z',expiresAt:'2026-10-14T00:00:00Z',pricePolicyVersion:'verified-later',capabilitySnapshotId:'cap1',creditsQuoted:10,maxHoldUnits:10,
  wallet:{unit:'credits',availableUnits:12,reservedUnits:2,heldForReviewUnits:1,snapshotAt:'2026-10-13T00:00:00Z',walletRevision:'w1'},
  consentTextVersion:'policy-pending',included:['three_new_concepts','two_optional_included_refinements'],excluded:['standard_final_render','digital_art_export','personalized_garment','printing','shipping'],
  authorizationHint:{quoteId:'quote1' as QuoteId,checkedAt:'2026-10-13T00:00:00Z',canAuthorize:false,reasonCodes:['TERMS_NOT_APPROVED'],quoteVersionId:'v3'},
  projectId:'p1' as ProjectId,approvedPlanVersionId:'plan1',directionIds:dir,includedRefinements:2,finalRenderIncludedInThisPurchase:false,physicalGarmentIncluded:false,
  downstreamEligibility:{region:'US',evaluatedAt:'2026-10-13T00:00:00Z',rightsNoticeVersion:'rights-pending',uses:[{kind:'digital_art_export',status:'eligible',region:'US',rightsDecision:'commercial_use_permitted',rightsPolicyVersion:'r1',restrictions:[],exclusionReasonCodes:[],humanSummary:'potential after verification'}, {kind:'personalized_garment',status:'ineligible',region:'US',rightsDecision:'not_permitted',rightsPolicyVersion:null,restrictions:['physical route not verified'],exclusionReasonCodes:['DOWNSTREAM_USE_UNAVAILABLE'],humanSummary:'not yet offered'}],quotedEligibleUses:['digital_art_export']},
  standardFinalQualified:true,promoOffsetCredits:0,
  paidTerms:{customerConsentTermsVersion:'pending-c',expiryTermsVersion:'pending-e',partialRemedyTermsVersion:'pending-r',rightsNoticeVersion:'pending-rights',qualityRemedyTermsVersion:'pending-quality',refinementClosureNoticeVersion:null},
};
const check=(name:string,input:unknown,expected:boolean)=>{
  const result=validateQuoteMockShape(input);if(result.valid!==expected)throw new Error(`${name}: ${JSON.stringify(result.errors)}`);
};
check('structurally-valid-proposal-fixture',quote,true);
check('missing mandatory terms',{...quote,paidTerms:{...quote.paidTerms,partialRemedyTermsVersion:null}},false);
check('wrong downstream use still alternative eligible',{...quote,downstreamEligibility:{...quote.downstreamEligibility,quotedEligibleUses:['personalized_garment']}},false);
check('missing mapping',{...quote,directionIds:[]},false);
check('duplicate mapping',{...quote,directionIds:['d1','d1','d3']},false);
check('negative credits',{...quote,creditsQuoted:-1},false);
check('no eligibility disclosure',{...quote,downstreamEligibility:{...quote.downstreamEligibility,uses:[]}},false);
check('hint references different quote',{...quote,authorizationHint:{...quote.authorizationHint,quoteId:'other'}},false);
if(hasCompleteDirectionMapping(['d1','d1','d3'] as unknown as DirectionId[]))throw new Error('duplicate direction check failed');
// A structurally valid mock is STILL NOT authorization: expired/revoked/region/terms approval must be checked by server.
// These are scenario declarations for future BFF negative integration fixtures; no real capability service exists.
const serverNegativeCases=['expired_quote','quote_use_mismatch','revoked_rights','region_changed','unapproved_disclosure_terms','stale_price_policy','stale_owner','wallet_insufficient','model_unqualified'];
if(serverNegativeCases.length!==9)throw new Error('test fixture registration mismatch');
console.log('8 shape-negative checks plus 9 declared server-only negative scenarios; NOT real authorization acceptance');
import {validateStudioScreenMockShape} from './vynvori-v1_1-proposed';
import type {StudioScreenV1,CustomerBundleFinancialSummaryV1,ConceptCardV1} from './vynvori-v1_1-proposed';
const finance:CustomerBundleFinancialSummaryV1={packageId:'pkg',quoteId:'quote1' as QuoteId,quotedTotalUnits:10,maximumAuthorizedHoldUnits:10,currentlyReservedUnits:6,currentlyHeldForReviewUnits:4,cumulativelySettledUnits:0,cumulativelyReleasedUnits:0,receiptIds:[],supportCaseIds:['case1'],recordedAt:'2026-10-13T00:00:00Z'};
const card=(n:1|2|3,st:'delivered'|'under_review'|'waiting'):ConceptCardV1=>({slotNumber:n,directionId:`d${n}` as DirectionId,directionTitle:`Direction ${n}`,status:st,versionId:st==='delivered'?'v1' as never:null,safePreviewUrl:st==='delivered'?'/mock-signed-url':null,accessibleDescription:`Direction ${n} artwork`,operation:null,receiptId:null,sourceRightsSummary:'demo only',isSelected:false});
const partial:StudioScreenV1={schemaVersion:'studio-screen.v1',route:'/studio/projects/p1',projectId:'p1' as ProjectId,status:null,availableActions:['view_partial','open_support'],errorCode:'PARTIAL_DELIVERY',supportCases:[],history:[],screenId:'ST-10',stage:'concepts_partial',conceptCards:[card(1,'delivered'),card(2,'under_review'),card(3,'waiting')],bundleFinancials:finance};
const mockCheck=(name:string,value:unknown,want:boolean)=>{const x=validateStudioScreenMockShape(value);if(x.valid!==want)throw Error(`${name}: ${JSON.stringify(x.errors)}`)};
mockCheck('valid 1/3 with financial review',partial,true);
mockCheck('missing concept card',{...partial,conceptCards:partial.conceptCards.slice(0,2)},false);
mockCheck('bogus route screen mismatch',{...partial,stage:'history'},false);
mockCheck('internal provider leakage',{...partial,conceptCards:[{...partial.conceptCards[0],vendorCostEvidence:'invoice'},partial.conceptCards[1],partial.conceptCards[2]]},false);
mockCheck('unsupported public entry BYO',{...partial,screenId:'ST-00',stage:'entry',byoLink:'#results'},false);
console.log('5 screen-mock checks completed; production Zod/BFF/E2E acceptance NOT_RUN');
