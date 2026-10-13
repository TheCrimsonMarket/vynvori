# 07 — Independent Garment Composition Editor

## Product boundary

Public route `/customize`, usable without AI credits or AI account. User uploads an existing original design, arranges multiple layers on black oversized T-shirt mockups, previews freely, and can either order a shirt or buy a finished composition export. AI Studio links to `/customize?designVersion=...` after art approval; editor does not depend on AI provider availability.

## MVP features

- Guest create/edit/preview (ephemeral), sign in for durable save, paid export or checkout.
- Upload PNG/JPEG/WebP; sanitized SVG may be added through server conversion after review. Reject malicious SVG, oversized decompression, unsupported vectors, external asset references. PSD/PDF imports outside MVP.
- Front/back and only manufacturer-supported sleeves, each with independent layers. Selected launch product: black oversized T-shirt with size variants.
- Image layers: move, scale uniformly/nonuniform if allowed by aspect policy, rotate, flip (optional), duplicate, delete, reorder, hide, lock, opacity only where print-compatible.
- Text layers: editable exact string, font family from licensed installed fonts, weight, color, tracking, spacing, alignment, rotation, wrap; deterministic text layout in renderer using controlled font assets.
- Alignment tools: snapping to zone center, distribution, safe bounds, numeric transform controls, undo/redo and layer history.
- Mockup: 2D transparent artwork overlay on calibrated black garment base for selected front/back/size. Composition state independent of garment pixels. No claims of exact physical appearance without supplier proof.
- Async autosave for authenticated sessions; stable scene schema version; snapshots immutable once quoted/purchased; restore history without overwriting paid versions.

## Coordinate spaces

`print_profile` defines width/height in **millimeters** for each print zone. Composer maintains physical `x_mm`, `y_mm`, `w_mm`, `h_mm`, angle degrees or normalized 0..1 transforms with a reproducible conversion layer. CSS/viewport dimensions are not persisted as production geometry. Canvas editor pixel measurements are display only.

Layer bounds include print bleed/safety zones; source aspect ratio and crop metadata explicit. Effective raster PPI from original pixel crop width / printed physical width in inches; support configurable minimums per printer/placement (300 PPI full-size target is provisional; do not treat as confirmed). Scaling down may fit; scaling up cannot create missing detail. Block order when required print checks fail, or allow an explicit qualified enhancement workflow with customer review.

## Scene format example (illustrative)

```json
{
  "schemaVersion": "1.0",
  "compositionVersionId": "cv_immutable",
  "productFamily": "black-oversized-tee",
  "pages": [{
    "zone": "back",
    "printProfileId": "profile_pending_supplier_approval",
    "layers": [
      { "id":"layer_a", "type":"image", "assetId":"asset_uuid", "z":0,
        "xMm":42, "yMm":65, "widthMm":210, "heightMm":280, "rotationDeg":0, "visible":true },
      { "id":"layer_t", "type":"text", "z":1, "text":"I'M ONLY MAPPING",
        "fontAssetId":"font_licensed_id", "fontSizePt":30, "xMm":50, "yMm":20,
        "widthMm":200, "rotationDeg":0, "color":"#ffffff", "visible":true }
    ]
  }]
}
```

The example uses **fictional print profile identifiers and coordinates** solely to show data shape. Validate scene with Zod or equivalent and enforce range/size/area constraints server-side before persistence and order quoting.

## Security and integrity

Each uploaded asset has validated owner/guest-session lineage; signed upload cannot be reused for unrelated accounts; immutable version hash includes source hashes and font versions. UI-visible text never treated as HTML. Prevent arbitrary CORS/SSRF/object keys. Merchant-side price quote generated only after user/asset/zone authorization and scene profile validation.

## Performance

Pan/zoom and responsive canvas; preview thumbnails may be downscaled; editor keeps original asset refs separately. Limits for maximum layers, asset bytes and total decoded image memory are configurable; mobile actions accessible via panels and touch transforms. Autosave must debounce, cancel stale writes, reconcile conflict versions on reconnect, and warn before losing guest drafts.

## Acceptance tests

Anonymous user imports image and previews; signed-in owner saves/resumes; changed text preserved and rendered exactly; front/back layers independent; overlay coordinate conversion identical on two screen sizes; low-res large-area design warned/blocked by server; forged zone cost rejected; snapshot referenced by cart immutable after subsequent editing; BYO customer never charged AI credits.
