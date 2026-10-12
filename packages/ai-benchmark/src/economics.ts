export interface EconomicsInput {
  conceptUsd: number; editUsd: number; standardFinalUsd: number; premiumFinalUsd: number;
  promptAndStorageUsd: number; processingAndSupportUsd: number;
  paymentRate: number; paymentFixedUsd: number; fundingFeeRate: number;
  creditUnitUsd: number; redemptionUsd: number;
}
export function simulate(input: EconomicsInput) {
  const fields=['conceptUsd','editUsd','standardFinalUsd','premiumFinalUsd','promptAndStorageUsd','processingAndSupportUsd','paymentRate','paymentFixedUsd','fundingFeeRate','creditUnitUsd','redemptionUsd'] as const;
  for (const field of fields) if(!Number.isFinite(input[field])||input[field]<0)throw new Error(`Invalid economics assumption: ${field}`);
  if(input.paymentRate>=1||input.creditUnitUsd<=0)throw new Error('Invalid payment rate or credit denomination');
  const rows=[];
  for(const tier of ['standard','premium'] as const)for(const retryFactor of [1,1.5,2])for(const multiplier of [3,3.5,4]) {
    const apiSessionUsd=(3*input.conceptUsd+2*input.editUsd+(tier==='standard'?input.standardFinalUsd:input.premiumFinalUsd))*retryFactor;
    const effectiveSessionUsd=apiSessionUsd*(1+input.fundingFeeRate)+input.promptAndStorageUsd+input.processingAndSupportUsd;
    const targetUsd=effectiveSessionUsd*multiplier;
    const credits=Math.ceil((targetUsd-1e-10)/input.creditUnitUsd);
    const priceUsd=credits*input.creditUnitUsd;
    const paymentFeeUsd=priceUsd*input.paymentRate+input.paymentFixedUsd;
    const contributionUsd=priceUsd-effectiveSessionUsd-paymentFeeUsd-input.redemptionUsd;
    const minimumPackUsd=Math.ceil((5-1e-10)/input.creditUnitUsd)*input.creditUnitUsd;
    const requiredTopupUsd=Math.max(minimumPackUsd,priceUsd);
    rows.push({tier,scenario:retryFactor===1?'base':retryFactor===1.5?'conservative':'high-retry',retryFactor,multiplier,
      apiSessionUsd,effectiveSessionUsd,credits,priceUsd,paymentFeeUsd,redemptionUsd:input.redemptionUsd,
      contributionUsd,requiredTopupUsd,creditUnitUsd:input.creditUnitUsd,
      boundaryPermitted:contributionUsd>0,evidence:'User-supplied qualified costs and explicit assumptions; scenario, not guarantee'});
  }
  return rows;
}
