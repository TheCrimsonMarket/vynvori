# 08 — Asset lifecycle, secure uploads, deterministic printing

## Storage architecture

Cloudflare R2 private bucket(s) or appropriately access-controlled prefixes:

```text
private/guest/{scope}/upload/{asset-id}
private/users/{user-id}/original/{asset-id}
private/users/{user-id}/derivative/{asset-id}
private/production/{production-job-id}/proof/{hash}
private/production/{production-job-id}/print/{hash}
public/gallery/{approved-post-id}/{watermarked-preview-hash}
```

Actual keys opaque/non-guessable; names shown are conceptual. Do not expose user IDs in public paths if unnecessary. Object metadata: size, sha256, MIME (magic bytes), dimensions, ICC/color profile observations, alpha, provenance, source rights, retention, created_at. Use restricted presigned uploads with key/size/content-type/time caps and server-side confirmation. Validate and transcode **after** upload and before making bytes usable. Remove EXIF/location metadata from public derivatives.

## Upload service

1. `POST /api/assets/upload-intents` receives declared MIME, byte size, purpose and guest/account identity.
2. Checks quotas/ownership, issues short-lived presigned R2 PUT only for exact target key.
3. Client uploads and reports completion; server HEADs/reads object, verifies dimensions/magic/hash/scans and content safety, commits asset record as `ready`.
4. Reject or quarantine malformed/abusive files; expired guest assets garbage-collected, respecting references to migrated projects.
5. Download URLs short-lived and owner-checked. Community only serves approved derived art; no original private object URLs in API JSON.

## Production rendering

Cloud Run endpoint (service-to-service authenticated) receives `RenderPrintJob` with canonical composition version ID/content hash, specific source asset IDs/hashes, print profile version, output policy and idempotency key. It resolves assets through privileged scoped repository service, **not URLs chosen by client**. Normalize image orientation/ICC, rasterize exact fonts in controlled environment, apply physical mm transforms, draw layers in order with deterministic clipping and alpha handling, create transparent print artifact and proof overlay separately.

Artifacts must record: pixel dimensions, physical mm, effective PPI per raster layer, format (PNG/TIFF/PDF etc depending on supplier approval), alpha/edge quality checks, ICC info, coverage, render-engine version and file SHA256. Never claim DPI metadata alone fixes resolution. Full source/artwork remains immutable; original file can be reprocessed with new print profile without corrupting old approvals.

## DTF-specific validation

- Launch method DTF only; no DTG pipeline. Printer-approved profile controls maximum platen/sheet area, placement per size, bleed/safety margin, min effective detail resolution, accepted color/profile, transparent background, small-line thresholds and output file type.
- Automated preflight: bounding boxes, forbidden overlap, raster effective PPI, missing pixels/alpha, unembedded/unlicensed fonts, oversize, unsupported formats, missing source hashes, potential problematic gradients/small strokes, required white-underbase proof notes. Some checks advisory; any supplier hard requirement blocks print release.
- Physical QA: compare 220 vs 240 GSM identical DTF artwork, wash durability, handfeel, color, stretch, fine details and dimensional change. Supplier signoff necessary before production profiles can be marked `approved`.
- Proof images are for human and customer review; never print from proof JPEG/mockup. If operation modifies approved design materially, generate new proof and require customer approval.

## Print-job lifecycle

`created → assets_verified → preflight_pending → qa_pending → qa_approved → released_to_print → printer_ack → printed → inspected → packed → dispatched`; exception states: `needs_fix`, `customer_reapproval`, `rejected`, `cancelled`, `refunded`. Only authorized human QA actor can transition `qa_pending → qa_approved`; releasing checks valid payment, unchanged proof hash and approved print profile.

## Operational behavior

Retries of deterministic render may be safe only with same immutable content-hash idempotency key; keep each output immutable and compare sha256. Export purchase entitlement required to expose print-ready composition download externally; production render for purchased shirt is internal and not an extra customer export sale. Automatic removal/retention subject to consumer support, chargeback and privacy needs.

## Tests

Malicious SVG and decompression bombs, EXIF stripping, asset IDOR, quote with missing assets, oversized uploaded image, alpha checkerboard illusion vs real alpha, scene visual golden fixtures, true physical dimension measurement, low PPI threshold, versioned fonts, stolen presigned URL, idempotent duplicate render, no print release absent human signoff, print artifact different from UI screenshot.
