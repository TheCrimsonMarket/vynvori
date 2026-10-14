/** Deliberately contains no environment reads or server credentials. */
export const featureDefaults = Object.freeze({
  "identity.central_sso": false,
  "commerce.checkout_live": false,
  "payments.live": false,
  "studio.ai_generation_paid": false,
  "studio.premium_final": false,
  "studio.advanced_model_selector": false,
  "studio.free_promo": false,
  "credits.purchasing": false,
  "exports.paid": false,
  "production.print_release": false,
  "gallery.publication": false,
  "assets.production_uploads": false,
  "shipping.australia_batch": false,
} as const);

export type Feature = keyof typeof featureDefaults;
export type FeatureFlags = Readonly<Record<Feature, false>>;
export const publicConfig = Object.freeze({ release: "M0 preview", features: featureDefaults });
