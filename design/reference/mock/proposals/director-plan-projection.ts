/** Isolated proposal only. No canonical contract edit; not used for mock authorization. */
import type {PlanDirectionV1,StudioScreenV1} from '../reference/vynvori-v1_1-proposed';
type ThreeDirections=readonly [PlanDirectionV1,PlanDirectionV1,PlanDirectionV1];
export type DirectorPlanProjectionV1=
 | {readonly kind:'draft';readonly draftPlanId:string;readonly revision:number;readonly directions:ThreeDirections;readonly conceptSlots:readonly [];readonly approvalHash?:never;readonly planVersionId?:never;}
 | {readonly kind:'approved';readonly planVersionId:string;readonly approvalHash:string;readonly directions:ThreeDirections;readonly conceptSlots:readonly [];};
export type ProposedST05=Omit<Extract<StudioScreenV1,{screenId:'ST-05'}>,'plan'> & {readonly plan:DirectorPlanProjectionV1};
