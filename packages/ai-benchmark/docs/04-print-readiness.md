# Provisional production gate

Operator selected provisional DTF on a black oversized shirt, front zone 300 × 400 mm, target 300 PPI. Supplier confirmation and physical prints are pending. Required target raster is at least 3544 × 4725 pixels. A2 is not assumed universally printable.

Technical export measures native width/height, raster format, alpha channel presence, estimated fully transparent pixel fraction and effective PPI: `min(width/(300/25.4), height/(400/25.4))`. Metadata DPI does not increase native detail. The print gate is FAIL below the target; otherwise CONDITIONAL until human/physical checks pass. Downsampled alpha statistics are a screening heuristic, not proof of clean edges or genuine transparency.

The output manifest contains per-image reasons. A 1024-square image fills a 400-mm-high zone at only about 65 PPI. A smaller placement may be suitable: its 300-PPI native maximum is about 86.7 mm square. A 2048-pixel edge corresponds to about 173.4 mm at 300 PPI. Report placement-specific possibilities separately from full-zone failure.

Before production: inspect artwork-only content, accidental clothing/shadows/logos, actual alpha vs painted checkerboard, halos and semi-transparent edges, color separation/white-underbase requirements, minimum line thickness, gradient behavior, black-fabric contrast and IP originality. Approve a separate print derivative while retaining the native original and provenance. Background removal or upscaling has not been evaluated and must not be presumed to rescue the gate.

Select at most two qualified derivatives for supplier DTF feasibility tests with garment fabric/weight, ink/film/powder, placement dimensions, press conditions, wash observations, correction history and photos. Current live API output alone does not qualify a model for production.
