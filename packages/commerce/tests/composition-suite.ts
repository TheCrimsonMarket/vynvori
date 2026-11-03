/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory test double mirrors loosely-typed SQL rows */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { canonicalSceneJson } from "@vynvori/contracts";
import type { AssetRecord, CompositionAccess, CompositionRecord, CompositionStore, VersionRecord } from "@vynvori/contracts/composition-port";
import { compositionService, CompositionError, secretHash, draftProjection } from "../src/composition";
import { SYNTHETIC_COMPOSITION_CONFIG, SYNTHETIC_GUEST_TTL_SECONDS } from "./composition-synthetic";
import { imageLayer, memoryStorage, png, jpeg, sceneWith, sha256, textLayer, webp } from "./composition-fixtures";

export type Harness = Readonly<{
  store: CompositionStore;
  /** Create a verified-user id (a profile row in PostgreSQL). */
  newUser(): Promise<string>;
  /** Simulates the M1b `claimGuest` effect: guest draft gets owner_id + claimed_at. */
  m1bClaim(draftId: string, userId: string): Promise<void>;
}>;

/** In-memory port implementation with the same access semantics as the SQL store. */
export function memoryHarness(): Harness {
  type Draft = { capabilityHash: string; expiresAt: Date; ownerId: string | null };
  const drafts = new Map<string, Draft>(), comps = new Map<string, any>(), assets = new Map<string, AssetRecord>(), versions = new Map<string, VersionRecord[]>();
  const ok = (c: any, access: CompositionAccess, now: Date) => access.kind === "owner" ? c.ownerUserId === access.userId
    : c.ownerUserId === null && !!c.guestDraftId && drafts.get(c.guestDraftId)?.capabilityHash === access.capabilityHash && drafts.get(c.guestDraftId)!.expiresAt > now && drafts.get(c.guestDraftId)!.ownerId === null;
  const project = (c: any): CompositionRecord => {
    const v = versions.get(c.id)?.find(x => x.id === c.currentVersionId);
    return { ...c, currentVersionSceneSha256: v?.sceneSha256 ?? null, guestExpiresAt: c.ownerUserId ? null : drafts.get(c.guestDraftId)?.expiresAt ?? null };
  };
  const store: CompositionStore = {
    async ensurePrintProfile() {},
    async createGuest(i) { drafts.set(i.id, { capabilityHash: i.capabilityHash, expiresAt: i.guestExpiresAt, ownerId: null });
      const c = { id: i.id, guestDraftId: i.id, ownerUserId: null, lifecycleState: i.state, scene: i.scene, sceneSha256: i.sceneSha256, draftRevision: 0, currentVersionId: null, printProfileId: i.scene.printProfileId, printProfileVersion: i.scene.printProfileVersion, createdAt: new Date(), updatedAt: new Date() };
      comps.set(i.id, c); return project(c); },
    async createOwned(i) { const c = { id: i.id, guestDraftId: null, ownerUserId: i.ownerUserId, lifecycleState: i.state, scene: i.scene, sceneSha256: i.sceneSha256, draftRevision: 0, currentVersionId: null, printProfileId: i.scene.printProfileId, printProfileVersion: i.scene.printProfileVersion, createdAt: new Date(), updatedAt: new Date() }; comps.set(i.id, c); return project(c); },
    async get(id, access, now) { const c = comps.get(id); return c && ok(c, access, now) ? project(c) : null; },
    async listOwned(userId) { return [...comps.values()].filter(c => c.ownerUserId === userId).map(project); },
    async saveDraft(id, access, now, i) { const c = comps.get(id); if (!c || !ok(c, access, now)) return { status: "not_found" };
      if (c.draftRevision !== i.expectedRevision) return { status: "conflict", currentRevision: c.draftRevision };
      Object.assign(c, { scene: i.scene, sceneSha256: i.sceneSha256, draftRevision: c.draftRevision + 1, lifecycleState: i.state, updatedAt: now }); return { status: "saved", record: project(c) }; },
    async adoptClaimedGuest(id, userId, hash, now) { const c = comps.get(id), d = c?.guestDraftId ? drafts.get(c.guestDraftId) : undefined;
      if (!c || c.ownerUserId !== null || !d || d.capabilityHash !== hash || d.ownerId !== userId) return null;
      c.ownerUserId = userId; if (["guest_draft", "editable_scene"].includes(c.lifecycleState)) c.lifecycleState = "saved_owned"; c.updatedAt = now; return project(c); },
    async insertAsset(id, access, now, a) { const c = comps.get(id); if (!c || !ok(c, access, now)) return null;
      const dup = [...assets.values()].find(x => x.compositionId === id && x.sha256 === a.sha256); if (dup) return dup;
      const row = { ...a, compositionId: id, createdAt: now }; assets.set(a.id, row); return row; },
    async getAsset(id, assetId, access, now) { const c = comps.get(id), a = assets.get(assetId); return c && a && a.compositionId === id && ok(c, access, now) ? a : null; },
    async listAssets(id, access, now) { const c = comps.get(id); return c && ok(c, access, now) ? [...assets.values()].filter(a => a.compositionId === id) : null; },
    async freeze(id, access, now, i) { const c = comps.get(id); if (!c || !ok(c, access, now)) return { status: "not_found" };
      if (c.draftRevision !== i.expectedRevision) return { status: "conflict", currentRevision: c.draftRevision };
      const list = versions.get(id) ?? []; let v = list.find(x => x.sceneSha256 === i.version.sceneSha256);
      if (!v) { v = { ...i.version, compositionId: id, versionNo: list.length + 1, frozenAt: now }; list.push(Object.freeze(v)); versions.set(id, list); }
      Object.assign(c, { currentVersionId: v.id, lifecycleState: i.state, updatedAt: now }); return { status: "frozen", version: v, record: project(c) }; },
    async getVersion(id, vid, access, now) { const c = comps.get(id); return c && ok(c, access, now) ? versions.get(id)?.find(v => v.id === vid) ?? null : null; },
    async listVersions(id, access, now) { const c = comps.get(id); return c && ok(c, access, now) ? versions.get(id) ?? [] : null; },
  };
  return { store, async newUser() { return randomUUID(); }, async m1bClaim(draftId, userId) { drafts.get(draftId)!.ownerId = userId; } };
}

const code = (promise: Promise<unknown>, expected: CompositionError["code"]) => assert.rejects(promise, (error: unknown) => error instanceof CompositionError && error.code === expected);

export function compositionConformance(label: string, factory: () => Promise<Harness>, options: { skip?: boolean } = {}) {
  const t = (name: string, fn: () => Promise<void>) => test(`${label}: ${name}`, { skip: options.skip ?? false }, fn);
  // Anchored to real time: the PostgreSQL store reads a new guest draft back with the real clock, so a fixed past date plus a short TTL would already be expired.
  let clock = new Date();
  const setup = async (uploads = true) => {
    const h = await factory(), storage = memoryStorage();
    const service = compositionService(h.store, storage, { ...SYNTHETIC_COMPOSITION_CONFIG, uploadsEnabled: uploads }, () => clock);
    return { h, storage, service };
  };
  const guest = async (service: ReturnType<typeof compositionService>) => {
    const created = await service.createGuest();
    return { id: created.record.id, access: { kind: "guest", capabilityHash: secretHash(created.capability) } as CompositionAccess, capability: created.capability, record: created.record };
  };
  t("guest draft is free, accountless and starts in guest_draft; only the capability hash is stored", async () => {
    clock = new Date();
    const { service } = await setup(); const g = await guest(service);
    assert.equal(g.record.lifecycleState, "guest_draft"); assert.equal(g.record.ownerUserId, null); assert.equal(g.capability.length, 43);
    assert.equal(JSON.stringify(g.record).includes(g.capability), false);
    const projection = draftProjection(g.record, g.access);
    assert.equal(projection.ownerKind, "guest_capability"); assert.equal(projection.canPersistToAccount, true);
  });
  t("guest rights: wrong capability, other draft's capability and expiry all look like NOT_FOUND", async () => {
    const { service } = await setup(); const a = await guest(service), b = await guest(service);
    await code(service.get(a.id, b.access), "NOT_FOUND");
    await code(service.get(a.id, { kind: "guest", capabilityHash: secretHash("x".repeat(43)) }), "NOT_FOUND");
    await code(service.saveDraft(a.id, b.access, 0, sceneWith()), "NOT_FOUND");
    assert.equal((await service.get(a.id, a.access)).id, a.id);
    clock = new Date(clock.getTime() + (SYNTHETIC_GUEST_TTL_SECONDS + 3600) * 1000);
    await code(service.get(a.id, a.access), "NOT_FOUND");
    await code(service.saveDraft(a.id, a.access, 0, sceneWith()), "NOT_FOUND");
    await code(service.freeze(a.id, a.access, 0), "NOT_FOUND");
    clock = new Date();
  });
  t("upload is closed by default (assets.production_uploads OFF) and never reaches storage", async () => {
    const { service, storage } = await setup(false); const g = await guest(service);
    await code(service.uploadAsset(g.id, g.access, png(), "image/png"), "UPLOADS_DISABLED");
    assert.equal(storage.objects.size, 0);
  });
  t("upload stores a private content-addressed original, dedupes, and rejects hostile input", async () => {
    const { service, storage } = await setup(); const g = await guest(service);
    const bytes = png(300, 200), asset = await service.uploadAsset(g.id, g.access, bytes, "image/png");
    assert.equal(asset.sha256, sha256(bytes)); assert.equal(asset.widthPx, 300); assert.equal(asset.objectKey, `private/composition/v1/${g.id}/${asset.sha256}`);
    assert.deepEqual([...storage.objects.get(asset.objectKey)!.bytes], [...bytes]); // unchanged original
    assert.equal((await service.uploadAsset(g.id, g.access, bytes, "image/png")).id, asset.id);
    assert.equal(storage.objects.size, 1);
    assert.equal((await service.uploadAsset(g.id, g.access, jpeg(), "image/jpeg")).mime, "image/jpeg");
    assert.equal((await service.uploadAsset(g.id, g.access, webp(), "image/webp")).mime, "image/webp");
    for (const [bytes_, mime, expected] of [
      [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), "image/svg+xml", "UNSUPPORTED_MEDIA"],
      [Buffer.from("GIF89a....................................."), "image/gif", "UNSUPPORTED_MEDIA"],
      [Buffer.alloc(0), "image/png", "UNSUPPORTED_MEDIA"],
      [png(4, 4, 9), "image/jpeg", "UNSUPPORTED_MEDIA"], // declared type does not match magic bytes
      [Buffer.concat([png(4, 4, 8), Buffer.from("<script>")]), "image/png", "UNSUPPORTED_MEDIA"], // polyglot trailer
      [png(30000, 30000, 7), "image/png", "UNSUPPORTED_MEDIA"], // decompression-bomb dimensions
      [webp(8, 8, true), "image/webp", "UNSUPPORTED_MEDIA"], // animated
    ] as const) await code(service.uploadAsset(g.id, g.access, bytes_, mime), expected);
    assert.equal(storage.objects.size, 3);
  });
  t("storage failure is surfaced, nothing is recorded, and a retry is idempotent", async () => {
    const { service, storage } = await setup(); const g = await guest(service);
    storage.failNext = true;
    await code(service.uploadAsset(g.id, g.access, png(10, 10), "image/png"), "STORAGE_UNAVAILABLE");
    assert.equal((await service.listAssets(g.id, g.access)).length, 0);
    assert.equal((await service.uploadAsset(g.id, g.access, png(10, 10), "image/png")).widthPx, 10);
  });
  t("assets are scoped to their composition: no cross-owner read, upload or layer reference", async () => {
    const { service } = await setup(); const a = await guest(service), b = await guest(service);
    const asset = await service.uploadAsset(a.id, a.access, png(2000, 2000), "image/png");
    await code(service.readAsset(a.id, asset.id, b.access), "NOT_FOUND");
    await code(service.readAsset(b.id, asset.id, b.access), "NOT_FOUND"); // right owner, wrong composition id
    assert.equal((await service.readAsset(a.id, asset.id, a.access)).bytes.byteLength > 0, true);
    await code(service.saveDraft(b.id, b.access, 0, sceneWith([imageLayer("l1", asset.id, asset.sha256)])), "ASSET_NOT_OWNED");
    await code(service.saveDraft(a.id, a.access, 0, sceneWith([imageLayer("l1", asset.id, "0".repeat(64))])), "ASSET_NOT_OWNED");
    await code(service.uploadAsset(a.id, b.access, png(5, 5), "image/png"), "NOT_FOUND");
  });
  t("scene validation: unlicensed font, huge geometry and wrong profile are rejected before persistence", async () => {
    const { service } = await setup(); const g = await guest(service);
    await code(service.saveDraft(g.id, g.access, 0, sceneWith([textLayer("t", { fontFileSha256: "c".repeat(64) })])), "FONT_UNLICENSED");
    await code(service.saveDraft(g.id, g.access, 0, sceneWith([textLayer("t", { xMm: 1e7 })])), "SCENE_LIMIT");
    await code(service.saveDraft(g.id, g.access, 0, { ...sceneWith(), printProfileVersion: "other" }), "INVALID_SCENE");
    await code(service.saveDraft(g.id, g.access, 0, { nonsense: true }), "INVALID_SCENE");
    assert.equal((await service.get(g.id, g.access)).draftRevision, 0);
  });
  t("geometry is identical after reload (millimetres, 1 µm canonical form) and the hash is stable", async () => {
    const { service } = await setup(); const g = await guest(service);
    const asset = await service.uploadAsset(g.id, g.access, png(3000, 3000), "image/png");
    const saved = await service.saveDraft(g.id, g.access, 0, sceneWith([imageLayer("l1", asset.id, asset.sha256), textLayer("t1")], [textLayer("t2", { text: "BACK" })]));
    const reloaded = await service.get(g.id, g.access);
    assert.equal(canonicalSceneJson(reloaded.scene), canonicalSceneJson(saved.scene));
    assert.deepEqual(reloaded.scene, saved.scene);
    const layer = reloaded.scene.pages.find(p => p.zoneId === "front")!.layers.find(l => l.layerId === "l1")!;
    assert.equal(layer.xMm, 20); assert.equal(layer.yMm, 20.123); assert.equal(layer.rotationDeg, 12.5);
    assert.equal(reloaded.sceneSha256, saved.sceneSha256); assert.equal(reloaded.lifecycleState, "editable_scene");
  });
  t("optimistic revisions: a stale writer gets REVISION_CONFLICT and cannot overwrite", async () => {
    const { service } = await setup(); const g = await guest(service);
    const first = await service.saveDraft(g.id, g.access, 0, sceneWith([textLayer("t", { text: "FIRST" })]));
    assert.equal(first.draftRevision, 1);
    await assert.rejects(service.saveDraft(g.id, g.access, 0, sceneWith([textLayer("t", { text: "STALE" })])), (e: unknown) => e instanceof CompositionError && e.code === "REVISION_CONFLICT" && e.detail === "1");
    const layer = (await service.get(g.id, g.access)).scene.pages.find(p => p.zoneId === "front")!.layers[0]!;
    assert.equal(layer.kind === "text" && layer.text, "FIRST");
  });
  t("frozen versions are immutable; edits start a new draft; restore never rewrites history", async () => {
    const { service, h } = await setup(); const g = await guest(service);
    const asset = await service.uploadAsset(g.id, g.access, png(3000, 3000), "image/png");
    const s1 = await service.saveDraft(g.id, g.access, 0, sceneWith([imageLayer("l1", asset.id, asset.sha256)]));
    const frozen = await service.freeze(g.id, g.access, s1.draftRevision);
    assert.equal(frozen.version.versionNo, 1); assert.equal(frozen.record.lifecycleState, "frozen_version"); assert.equal(frozen.version.sceneSha256, s1.sceneSha256);
    assert.equal(frozen.version.preflightState, "preview_only");
    assert.equal((await service.freeze(g.id, g.access, s1.draftRevision)).version.id, frozen.version.id); // idempotent
    const s2 = await service.saveDraft(g.id, g.access, s1.draftRevision, sceneWith([imageLayer("l1", asset.id, asset.sha256, { xMm: 40 })]));
    assert.equal(s2.lifecycleState, "editable_scene");
    assert.equal(draftProjection(s2, g.access).hasUnfrozenChanges, true);
    const v1 = await service.getVersion(g.id, frozen.version.id, g.access);
    assert.equal(v1.sceneSha256, s1.sceneSha256); assert.deepEqual(v1.scene, s1.scene);
    const second = await service.freeze(g.id, g.access, s2.draftRevision);
    assert.equal(second.version.versionNo, 2);
    const restored = await service.restore(g.id, g.access, frozen.version.id, s2.draftRevision);
    assert.deepEqual(restored.scene, s1.scene); assert.equal(restored.draftRevision, s2.draftRevision + 1);
    const versions = await service.listVersions(g.id, g.access);
    assert.deepEqual(versions.map(v => v.versionNo), [1, 2]); assert.equal(versions[1]!.sceneSha256, s2.sceneSha256);
    assert.equal((await service.get(g.id, g.access)).currentVersionId, second.version.id);
    void h;
  });
  t("preflight is preview-only: out-of-bounds freezes as blocked, nothing is ever print-eligible", async () => {
    const { service } = await setup(); const g = await guest(service);
    const asset = await service.uploadAsset(g.id, g.access, png(3000, 3000), "image/png");
    const saved = await service.saveDraft(g.id, g.access, 0, sceneWith([imageLayer("l1", asset.id, asset.sha256, { xMm: 150 })]));
    const { version } = await service.freeze(g.id, g.access, saved.draftRevision);
    assert.equal(version.preflightState, "blocked"); assert.ok(version.preflightIssues.some(i => i.code === "LAYER_OUT_OF_BOUNDS"));
    assert.ok(version.preflightIssues.some(i => i.code === "PRINT_PROFILE_UNAPPROVED"));
    assert.equal(service.profile.printReleaseEligible, false);
  });
  t("owner rights: durable composition, own listing only, strangers see NOT_FOUND", async () => {
    const { service, h } = await setup(); const u1 = await h.newUser(), u2 = await h.newUser();
    const mine = await service.createOwned(u1);
    assert.equal(mine.lifecycleState, "saved_owned");
    const o1: CompositionAccess = { kind: "owner", userId: u1 }, o2: CompositionAccess = { kind: "owner", userId: u2 };
    await code(service.get(mine.id, o2), "NOT_FOUND"); await code(service.saveDraft(mine.id, o2, 0, sceneWith()), "NOT_FOUND"); await code(service.freeze(mine.id, o2, 0), "NOT_FOUND");
    assert.equal((await service.list(u1)).length, 1); assert.equal((await service.list(u2)).length, 0);
    const saved = await service.saveDraft(mine.id, o1, 0, sceneWith([textLayer("t")]));
    assert.equal(saved.lifecycleState, "saved_owned");
    const { record } = await service.freeze(mine.id, o1, saved.draftRevision);
    assert.equal(record.lifecycleState, "frozen_version");
    const edited = await service.saveDraft(mine.id, o1, saved.draftRevision, sceneWith([textLayer("t", { text: "EDIT" })]));
    assert.equal(edited.lifecycleState, "saved_owned"); // frozen -> editable_scene -> saved_owned
    await code(service.createOwned(u1, sceneWith([imageLayer("l", randomUUID(), "a".repeat(64))])), "ASSET_NOT_OWNED");
  });
  t("guest claim needs BOTH the capability and the verified M1b claim, then the capability stops working", async () => {
    const { service, h } = await setup(); const g = await guest(service), user = await h.newUser(), other = await h.newUser();
    const saved = await service.saveDraft(g.id, g.access, 0, sceneWith([textLayer("t", { text: "MINE" })]));
    await code(service.claim(g.id, user, g.capability), "NOT_FOUND"); // M1b claim not performed yet
    await code(service.claim(g.id, user, "y".repeat(43)), "NOT_FOUND");
    await h.m1bClaim(g.id, user);
    await code(service.claim(g.id, other, g.capability), "NOT_FOUND"); // a different verified user cannot adopt
    await code(service.claim(g.id, user, "y".repeat(43)), "NOT_FOUND"); // wrong capability
    const claimed = await service.claim(g.id, user, g.capability);
    assert.equal(claimed.ownerUserId, user); assert.equal(claimed.lifecycleState, "saved_owned"); assert.equal(claimed.sceneSha256, saved.sceneSha256);
    await code(service.get(g.id, g.access), "NOT_FOUND"); // leaked capability is now useless
    assert.equal((await service.claim(g.id, user, g.capability)).id, g.id); // replay is idempotent
    assert.equal((await service.get(g.id, { kind: "owner", userId: user })).draftRevision, saved.draftRevision);
    await code(service.get(g.id, { kind: "owner", userId: other }), "NOT_FOUND");
  });
}
