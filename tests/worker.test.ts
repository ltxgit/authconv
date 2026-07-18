import { File } from "node:buffer";
import { beforeAll, describe, expect, it, vi } from "vitest";
import openAiJwks from "../src/jwks/openai.json" with { type: "json" };
import type { WorkerRequest, WorkerResponse } from "../src/web/worker-protocol.js";

type RequestWithoutId = WorkerRequest extends infer Request
  ? Request extends { requestId: number }
    ? Omit<Request, "requestId" | "verifyTokens"> & { verifyTokens?: boolean }
    : never
  : never;

let onMessage: ((event: { data: WorkerRequest }) => void) | undefined;
const responses: WorkerResponse[] = [];
const waiters = new Set<() => void>();
let nextRequestId = 1;

beforeAll(async () => {
  vi.stubGlobal("self", {
    addEventListener(type: string, listener: (event: { data: WorkerRequest }) => void) {
      if (type === "message") onMessage = listener;
    },
    postMessage(message: WorkerResponse) {
      responses.push(message);
      for (const wake of [...waiters]) wake();
    },
  });
  await import("../src/web/worker.js");
});

describe("Dedicated Worker contract", () => {
  it("uses the accepted draft for preview and download before AccountStore commit", async () => {
    await request({ type: "clear" });
    const draft = JSON.stringify([
      { platform: "openai", credentials: { access_token: "same", email: "first@example.com" } },
      { platform: "openai", credentials: { access_token: "same", refresh_token: "refresh" } },
    ]);
    const previewed = await request({ type: "previewText", text: draft });
    expect(previewed.final).toMatchObject({
      type: "previewTextResult",
      summary: { scope: "draft", active: { total: 2 }, loaded: { total: 0 } },
    });

    const uncommittedOutput = await request({
      type: "preview",
      formats: ["sub2api"],
      previewFormat: "sub2api",
      outputModes: { sub2api: "merged" },
      textMode: "json",
      includeRefreshToken: true,
      allowSyntheticIdToken: true,
    });
    expect(uncommittedOutput.final).toMatchObject({
      type: "previewResult",
      totalAccounts: 2,
      outputPlan: { accountCount: 2 },
      text: expect.stringContaining("first@example.com"),
    });

    const downloaded = await request({
      type: "export",
      formats: ["sub2api"],
      outputModes: { sub2api: "merged" },
      textMode: "json",
      includeRefreshToken: true,
      allowSyntheticIdToken: true,
    });
    expect(downloaded.final).toMatchObject({ type: "exportResult", accountCount: 2 });

    const committed = await request({ type: "commitDraft", verifyTokens: false });
    expect(committed.final).toMatchObject({
      type: "commitDraftResult",
      summary: { scope: "loaded", loaded: { total: 1 } },
    });
  });

  it("discards an accepted draft before replacement text can participate in output", async () => {
    await request({ type: "clear" });
    await request({
      type: "previewText",
      text: JSON.stringify({
        platform: "openai",
        credentials: { access_token: "old-draft", email: "old@example.com" },
      }),
    });

    const discarded = await request({ type: "discardDraft" });
    expect(discarded.final).toMatchObject({
      type: "discardDraftResult",
      summary: { scope: "loaded", active: { total: 0 } },
    });

    const preview = await request({
      type: "preview",
      formats: ["sub2api"],
      previewFormat: "sub2api",
      outputModes: { sub2api: "merged" },
      textMode: "json",
      includeRefreshToken: true,
      allowSyntheticIdToken: true,
    });
    expect(preview.final).toMatchObject({
      type: "previewResult",
      text: "",
      outputPlan: { accountCount: 0, fileCount: 0 },
    });
  });

  it("does not clear an accepted draft after an export takes task ownership", async () => {
    await request({ type: "clear" });
    await request({
      type: "previewText",
      text: '{"platform":"openai","credentials":{"access_token":"accepted-draft"}}',
    });

    const supersededId = post({
      type: "previewText",
      text: JSON.stringify(Array.from({ length: 1_024 }, (_, index) => ({
        platform: "openai",
        credentials: { access_token: `replacement-${index}` },
      }))),
    });
    const discardId = post({ type: "discardDraft" });
    const exportId = post({
      type: "export",
      formats: ["sub2api"],
      outputModes: { sub2api: "merged" },
      textMode: "json",
      includeRefreshToken: true,
      allowSyntheticIdToken: true,
    });

    expect(await waitForFinal(supersededId)).toMatchObject({ type: "error", cancelled: true });
    expect(await waitForFinal(discardId)).toMatchObject({ type: "error", cancelled: false });
    expect(await waitForFinal(exportId)).toMatchObject({ type: "exportResult", accountCount: 1 });
    await request({ type: "discardDraft" });
  });

  it("commits the accepted draft snapshot without restoring forged raw input", async () => {
    await request({ type: "clear" });
    const previewed = await request({
      type: "previewText",
      verifyTokens: true,
      text: JSON.stringify([
        { platform: "openai", credentials: { access_token: "a.b.c", email: "forged@example.com" } },
        { platform: "openai", credentials: { access_token: "opaque", email: "kept@example.com" } },
      ]),
    });
    expect(previewed.final).toMatchObject({
      type: "previewTextResult",
      summary: { scope: "draft", active: { total: 2, verificationCounts: { forged: 1, unverifiable: 1 } } },
    });

    const draftRange = await request({ type: "range", scope: "draft", offset: 0, limit: 10, query: "" });
    expect(draftRange.final).toMatchObject({
      type: "rangeResult",
      total: 2,
      items: [
        { email: "forged@example.com", tokenVerification: { status: "forged" } },
        { email: "kept@example.com", tokenVerification: { status: "unverifiable" } },
      ],
    });
    const committed = await request({ type: "commitDraft", verifyTokens: true });

    expect(committed.final).toMatchObject({
      type: "commitDraftResult",
      stats: { processed: 2, added: 1, skippedForged: 1 },
      summary: { loaded: { total: 1 } },
    });
    expect((await request({ type: "range", scope: "loaded", offset: 0, limit: 10, query: "kept" })).final)
      .toMatchObject({ type: "rangeResult", total: 1 });
    expect((await request({ type: "range", scope: "loaded", offset: 0, limit: 10, query: "forged" })).final)
      .toMatchObject({ type: "rangeResult", total: 0 });
  });

  it("ignores a stale row selection for merged previews", async () => {
    await request({ type: "clear" });
    const verify = vi.spyOn(crypto.subtle, "verify").mockResolvedValue(true);
    try {
      await request({
        type: "previewText",
        verifyTokens: true,
        text: JSON.stringify([
          { platform: "openai", credentials: { access_token: "a.b.c", email: "forged@example.com" } },
          {
            platform: "openai",
            credentials: { access_token: verifiableOpenAiToken(), email: "kept@example.com" },
          },
        ]),
      });
      const range = await request({ type: "range", scope: "draft", offset: 0, limit: 10, query: "" });
      if (range.final.type !== "rangeResult") throw new Error("expected rangeResult");
      const forged = range.final.items.find((item) => item.email === "forged@example.com");
      if (!forged) throw new Error("expected forged draft row");

      const preview = await request({
        type: "preview",
        formats: ["sub2api"],
        previewFormat: "sub2api",
        outputModes: { sub2api: "merged" },
        textMode: "json",
        selectedAccountId: forged.id,
        includeRefreshToken: true,
        allowSyntheticIdToken: true,
        verifyTokens: true,
      });

      expect(preview.final).toMatchObject({
        type: "previewResult",
        totalAccounts: 1,
        text: expect.stringContaining("kept@example.com"),
      });

      const blocked = await request({
        type: "preview",
        formats: ["sub2api"],
        previewFormat: "sub2api",
        outputModes: { sub2api: "single" },
        textMode: "json",
        selectedAccountId: forged.id,
        includeRefreshToken: true,
        allowSyntheticIdToken: true,
        verifyTokens: true,
      });
      expect(blocked.final).toMatchObject({
        type: "previewResult",
        text: "",
        blockedVerification: { status: "forged", reason: "malformed_jwt" },
      });
    } finally {
      await request({ type: "discardDraft" });
      verify.mockRestore();
    }
  });

  it("returns summaries and ranges, caps merged preview at 100, and streams export chunks", async () => {
    await request({ type: "clear" });
    const accounts = Array.from({ length: 150 }, (_, index) => ({
      platform: "openai",
      credentials: {
        access_token: `access-${index}`,
        email: `user-${index}@example.com`,
      },
    }));
    const imported = await request({
      type: "importFiles",
      files: [{
        file: new File([JSON.stringify(accounts)], "accounts.txt", { type: "text/plain" }) as unknown as globalThis.File,
        path: "accounts.txt",
      }],
    });

    expect(imported.final).toMatchObject({
      type: "importFilesResult",
      summary: { loaded: { total: 150 }, active: { total: 150 } },
    });
    expect(JSON.stringify(imported.final)).not.toContain("access-0");

    const range = await request({ type: "range", scope: "loaded", offset: 10, limit: 5, query: "" });
    expect(range.final).toMatchObject({ type: "rangeResult", total: 150, offset: 10 });
    if (range.final.type !== "rangeResult") throw new Error("expected rangeResult");
    expect(range.final.items).toHaveLength(5);
    expect(range.final.items[0]).toMatchObject({ email: "user-10@example.com" });
    expect(range.final.items[0]).not.toHaveProperty("accessToken");

    const preview = await request({
      type: "preview",
      formats: ["sub2api"],
      previewFormat: "sub2api",
      outputModes: { sub2api: "merged" },
      textMode: "json",
      includeRefreshToken: true,
      allowSyntheticIdToken: true,
    });
    expect(preview.final).toMatchObject({
      type: "previewResult",
      shownAccounts: 100,
      totalAccounts: 150,
    });
    if (preview.final.type !== "previewResult") throw new Error("expected previewResult");
    expect((JSON.parse(preview.final.text) as { accounts: unknown[] }).accounts).toHaveLength(100);

    const exported = await request({
      type: "export",
      formats: ["sub2api"],
      outputModes: { sub2api: "merged" },
      textMode: "json",
      includeRefreshToken: true,
      allowSyntheticIdToken: true,
    });
    expect(exported.final).toMatchObject({ type: "exportResult", accountCount: 150, mime: "application/json" });
    const chunks = exported.messages.filter((message): message is Extract<WorkerResponse, { type: "exportChunk" }> => (
      message.type === "exportChunk"
    ));
    expect(chunks.length).toBeGreaterThan(1);
    const text = new TextDecoder().decode(concat(chunks.map((message) => new Uint8Array(message.chunk))));
    expect((JSON.parse(text) as { accounts: unknown[] }).accounts).toHaveLength(150);
  });

  it("keeps the download plan but returns an empty merged preview when no searched account is selected", async () => {
    await request({ type: "clear" });
    await request({
      type: "importFiles",
      files: [{
        file: new File([JSON.stringify([
          { platform: "openai", credentials: { access_token: "one", email: "one@example.com" } },
          { platform: "openai", credentials: { access_token: "two", email: "two@example.com" } },
        ])], "accounts.json") as unknown as globalThis.File,
        path: "accounts.json",
      }],
    });

    const preview = await request({
      type: "preview",
      formats: ["sub2api"],
      previewFormat: "sub2api",
      outputModes: { sub2api: "merged" },
      textMode: "json",
      selectedAccountId: null,
      includeRefreshToken: true,
      allowSyntheticIdToken: true,
    });
    expect(preview.final).toMatchObject({
      type: "previewResult",
      text: "",
      totalAccounts: 0,
      outputPlan: { accountCount: 2, fileCount: 1 },
    });
  });

  it("keeps committed sources visible when a later file is cancelled", async () => {
    await request({ type: "clear" });
    await request({
      type: "importFiles",
      files: [
        {
          file: new File(['{"type":"codex","access_token":"base"}'], "00-base.json") as unknown as globalThis.File,
          path: "00-base.json",
        },
        {
          file: new File(['{"access_token":}'], "00-base-broken.json") as unknown as globalThis.File,
          path: "00-base-broken.json",
        },
      ],
    });
    let readerCancelled = false;
    let signalBlockedFileOpened: () => void = () => undefined;
    const blockedFileOpened = new Promise<void>((resolve) => {
      signalBlockedFileOpened = resolve;
    });
    const blockedFile = {
      stream() {
        signalBlockedFileOpened();
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('[{"platform":"openai","credentials":{"access_token":"partial"}}'));
          },
          cancel() {
            readerCancelled = true;
          },
        });
      },
    } as unknown as File;
    const importId = post({
      type: "importFiles",
      files: [
        {
          file: new File(['{"platform":"openai","credentials":{"access_token":"committed"}}'], "01.json") as unknown as globalThis.File,
          path: "01.json",
        },
        {
          file: new File(['{"access_token":}'], "02.json") as unknown as globalThis.File,
          path: "02.json",
        },
        { file: blockedFile, path: "03.json" },
      ],
    });
    await blockedFileOpened;
    const cancelled = await request({ type: "cancel" });
    const importFinal = await waitForFinal(importId);

    expect(cancelled.final).toMatchObject({
      type: "cancelResult",
      summary: {
        scope: "loaded",
        loaded: { total: 2 },
        inputFormat: "unknown",
        diagnostics: [
          { code: "json_parse_failed", sourceName: "00-base-broken.json" },
          { code: "json_parse_failed", sourceName: "02.json" },
        ],
      },
    });
    expect(importFinal).toMatchObject({ type: "error", cancelled: true });
    expect(readerCancelled).toBe(true);

    const after = await request({
      type: "importFiles",
      files: [{
        file: new File(['{"platform":"openai","credentials":{"access_token":"after-cancel"}}'], "after.json") as unknown as globalThis.File,
        path: "after.json",
      }],
    });
    expect(after.final).toMatchObject({
      type: "importFilesResult",
      summary: {
        loaded: { total: 3 },
        inputFormat: "unknown",
        diagnostics: [
          { code: "json_parse_failed", sourceName: "00-base-broken.json" },
          { code: "json_parse_failed", sourceName: "02.json" },
        ],
      },
    });
  });

  it("does not let a draft preview supersede an active file import", async () => {
    await request({ type: "clear" });
    let readerCancelled = false;
    const blockedFile = {
      stream() {
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('[{"platform":"openai","credentials":{"access_token":"partial"}}'));
          },
          cancel() {
            readerCancelled = true;
          },
        });
      },
    } as unknown as File;
    const importId = post({ type: "importFiles", files: [{ file: blockedFile, path: "blocked.json" }] });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const draft = await request({ type: "previewText", text: '{"access_token":"draft"}' });
    expect(draft.final).toMatchObject({ type: "error", cancelled: false });
    expect(readerCancelled).toBe(false);

    await request({ type: "cancel" });
    expect(await waitForFinal(importId)).toMatchObject({ type: "error", cancelled: true });
  });

  it("does not mix a superseded draft text with the previous draft accounts", async () => {
    await request({ type: "clear" });
    await request({
      type: "previewText",
      text: '{"platform":"openai","credentials":{"access_token":"draft-a","email":"draft-a@example.com"}}',
    });

    const supersededId = post({
      type: "previewText",
      text: '{"platform":"openai","credentials":{"access_token":"draft-b","email":"draft-b@example.com"}}',
    });
    const imported = await request({
      type: "importFiles",
      files: [{
        file: new File([
          '{"platform":"openai","credentials":{"access_token":"loaded"}}',
        ], "loaded.json") as unknown as globalThis.File,
        path: "loaded.json",
      }],
    });

    expect(await waitForFinal(supersededId)).toMatchObject({ type: "error", cancelled: true });
    expect(imported.final).toMatchObject({ type: "importFilesResult", summary: { scope: "draft" } });
    const committed = await request({ type: "commitDraft" });
    expect(committed.final).toMatchObject({ type: "commitDraftResult", stats: { processed: 1, added: 1 } });
    const oldDraft = await request({ type: "range", scope: "loaded", offset: 0, limit: 10, query: "draft-a" });
    const currentDraft = await request({ type: "range", scope: "loaded", offset: 0, limit: 10, query: "draft-b" });
    expect(oldDraft.final).toMatchObject({ type: "rangeResult", total: 1 });
    expect(currentDraft.final).toMatchObject({ type: "rangeResult", total: 0 });
  });

  it("lets only the latest queued draft replace the Worker draft", async () => {
    await request({ type: "clear" });
    const firstId = post({
      type: "previewText",
      text: '{"platform":"openai","credentials":{"access_token":"draft-a","email":"draft-a@example.com"}}',
    });
    const secondId = post({
      type: "previewText",
      text: '{"platform":"openai","credentials":{"access_token":"draft-b","email":"draft-b@example.com"}}',
    });
    const latestId = post({
      type: "previewText",
      text: '{"platform":"openai","credentials":{"access_token":"draft-c","email":"draft-c@example.com"}}',
    });

    expect(await waitForFinal(firstId)).toMatchObject({ type: "error", cancelled: true });
    expect(await waitForFinal(secondId)).toMatchObject({ type: "error", cancelled: true });
    expect(await waitForFinal(latestId)).toMatchObject({ type: "previewTextResult", summary: { scope: "draft" } });

    await request({ type: "commitDraft" });
    expect((await request({ type: "range", scope: "loaded", offset: 0, limit: 10, query: "draft-c" })).final)
      .toMatchObject({ type: "rangeResult", total: 1 });
    expect((await request({ type: "range", scope: "loaded", offset: 0, limit: 10, query: "draft-b" })).final)
      .toMatchObject({ type: "rangeResult", total: 0 });
  });

  it("keeps the last completed draft when a newer preview is manually cancelled", async () => {
    await request({ type: "clear" });
    await request({
      type: "previewText",
      text: '{"platform":"openai","credentials":{"access_token":"accepted-draft","email":"accepted-draft@example.com"}}',
    });
    const cancelledPreview = post({
      type: "previewText",
      text: JSON.stringify(Array.from({ length: 1_024 }, (_, index) => ({
        platform: "openai",
        credentials: {
          access_token: `cancelled-draft-${index}`,
          email: `cancelled-draft-${index}@example.com`,
        },
      }))),
    });
    const cancelled = await request({ type: "cancel" });

    expect(await waitForFinal(cancelledPreview)).toMatchObject({ type: "error", cancelled: true });
    expect(cancelled.final).toMatchObject({
      type: "cancelResult",
      cancelledTask: "previewText",
      summary: { scope: "draft", active: { total: 1 } },
    });

    await request({ type: "commitDraft" });
    expect((await request({ type: "range", scope: "loaded", offset: 0, limit: 10, query: "accepted-draft" })).final)
      .toMatchObject({ type: "rangeResult", total: 1 });
    expect((await request({ type: "range", scope: "loaded", offset: 0, limit: 10, query: "cancelled-draft" })).final)
      .toMatchObject({ type: "rangeResult", total: 0 });
  });

  it("cancels queued draft previews that arrived before the cancel request", async () => {
    await request({ type: "clear" });
    await request({
      type: "previewText",
      text: '{"platform":"openai","credentials":{"access_token":"accepted","email":"accepted@example.com"}}',
    });
    const activeId = post({
      type: "previewText",
      text: JSON.stringify(Array.from({ length: 1_024 }, (_, index) => ({
        platform: "openai",
        credentials: { access_token: `active-${index}` },
      }))),
    });
    const queuedId = post({
      type: "previewText",
      text: '{"platform":"openai","credentials":{"access_token":"queued","email":"queued@example.com"}}',
    });
    const cancelled = await request({ type: "cancel" });

    expect(await waitForFinal(activeId)).toMatchObject({ type: "error", cancelled: true });
    expect(await waitForFinal(queuedId)).toMatchObject({ type: "error", cancelled: true });
    expect(cancelled.final).toMatchObject({
      type: "cancelResult",
      cancelledTask: "previewText",
      summary: { scope: "draft", active: { total: 1 } },
    });

    await request({ type: "commitDraft" });
    expect((await request({ type: "range", scope: "loaded", offset: 0, limit: 10, query: "accepted" })).final)
      .toMatchObject({ type: "rangeResult", total: 1 });
    expect((await request({ type: "range", scope: "loaded", offset: 0, limit: 10, query: "queued" })).final)
      .toMatchObject({ type: "rangeResult", total: 0 });
  });

  it("rejects Store mutations while an export or import task is active", async () => {
    await request({ type: "clear" });
    await request({
      type: "importFiles",
      files: [{
        file: new File([JSON.stringify([
          { platform: "openai", credentials: { access_token: "export-a" } },
          { platform: "openai", credentials: { access_token: "export-b" } },
        ])], "export.json") as unknown as globalThis.File,
        path: "export.json",
      }],
    });
    const exportId = post({
      type: "export",
      formats: ["codex"],
      outputModes: {},
      textMode: "json",
      includeRefreshToken: true,
      allowSyntheticIdToken: true,
    });
    expect((await request({ type: "clear" })).final).toMatchObject({ type: "error", cancelled: false });
    expect(await waitForFinal(exportId)).toMatchObject({ type: "exportResult", accountCount: 2 });

    let releaseImport: (() => void) | undefined;
    const blockedFile = {
      stream() {
        return new ReadableStream<Uint8Array>({
          start(controller) {
            releaseImport = () => controller.close();
          },
        });
      },
    } as unknown as File;
    const importId = post({ type: "importFiles", files: [{ file: blockedFile, path: "blocked.json" }] });
    const firstId = (await request({ type: "range", scope: "loaded", offset: 0, limit: 1, query: "" })).final;
    if (firstId.type !== "rangeResult" || !firstId.items[0]) throw new Error("expected stored account");
    expect((await request({ type: "remove", id: firstId.items[0].id })).final)
      .toMatchObject({ type: "error", cancelled: false });
    releaseImport?.();
    await waitForFinal(importId);
  });

  it("cancels an in-flight output preview before re-verification mutates the Store", async () => {
    await request({ type: "clear" });
    const accounts = Array.from({ length: 512 }, (_, index) => ({
      platform: "openai",
      credentials: { access_token: `a.b.${index}`, email: `forged-${index}@example.com` },
    }));
    await request({
      type: "importFiles",
      verifyTokens: false,
      files: [{
        file: new File([JSON.stringify(accounts)], "forged.json") as unknown as globalThis.File,
        path: "forged.json",
      }],
    });

    const previewId = post({
      type: "preview",
      formats: ["sub2api"],
      previewFormat: "sub2api",
      outputModes: { sub2api: "merged" },
      textMode: "json",
      includeRefreshToken: true,
      allowSyntheticIdToken: true,
      verifyTokens: false,
    });
    const reverified = await request({ type: "reverify" });

    expect(await waitForFinal(previewId)).toMatchObject({ type: "error", cancelled: true });
    expect(reverified.final).toMatchObject({
      type: "reverifyResult",
      summary: { loaded: { total: 0 } },
    });
  });

  it("returns the committed Store snapshot when a later file has a fatal read error", async () => {
    await request({ type: "clear" });
    const readError = Object.assign(new Error("read failed"), { code: "EIO" });
    const brokenFile = {
      stream() {
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(readError);
          },
        });
      },
    } as unknown as File;

    const imported = await request({
      type: "importFiles",
      files: [
        {
          file: new File([
            '{"platform":"openai","credentials":{"access_token":"committed-before-error"}}',
          ], "01.json") as unknown as globalThis.File,
          path: "01.json",
        },
        { file: brokenFile, path: "02.json" },
      ],
    });

    expect(imported.final).toMatchObject({
      type: "error",
      cancelled: false,
      summary: { scope: "loaded", loaded: { total: 1 }, inputFormat: "sub2api" },
    });
  });

  it("keeps loaded accounts active for an invalid draft and clears stale diagnostics with the draft", async () => {
    await request({ type: "clear" });
    await request({
      type: "importFiles",
      files: [{
        file: new File(['{"platform":"openai","credentials":{"access_token":"loaded"}}'], "loaded.json") as unknown as globalThis.File,
        path: "loaded.json",
      }],
    });

    const invalid = await request({ type: "previewText", text: '{"access_token":' });
    expect(invalid.final).toMatchObject({
      type: "previewTextResult",
      summary: { scope: "loaded", active: { total: 1 }, diagnostics: [{ code: "json_parse_failed" }] },
    });

    const cleared = await request({ type: "previewText", text: "" });
    expect(cleared.final).toMatchObject({
      type: "previewTextResult",
      summary: { scope: "loaded", active: { total: 1 }, diagnostics: [] },
    });
  });

  it("keeps a visible valid draft intact across file import and clearing loaded accounts", async () => {
    await request({ type: "clear" });
    const draft = await request({
      type: "previewText",
      text: '{"platform":"openai","credentials":{"access_token":"draft-kept"}}',
    });
    expect(draft.final).toMatchObject({
      type: "previewTextResult",
      summary: { scope: "draft", active: { total: 1 }, loaded: { total: 0 } },
    });

    const imported = await request({
      type: "importFiles",
      files: [{
        file: new File([
          '{"platform":"openai","credentials":{"access_token":"loaded-file"}}',
        ], "loaded.json") as unknown as globalThis.File,
        path: "loaded.json",
      }],
    });
    expect(imported.final).toMatchObject({
      type: "importFilesResult",
      summary: { scope: "draft", active: { total: 1 }, loaded: { total: 1 } },
    });

    const cleared = await request({ type: "clear" });
    expect(cleared.final).toMatchObject({
      type: "clearResult",
      summary: { scope: "draft", active: { total: 1 }, loaded: { total: 0 } },
    });

    const committed = await request({ type: "commitDraft" });
    expect(committed.final).toMatchObject({
      type: "commitDraftResult",
      stats: { processed: 1, added: 1, merged: 0 },
      summary: { scope: "loaded", loaded: { total: 1 } },
    });
    const exported = await request({
      type: "preview",
      formats: ["sub2api"],
      previewFormat: "sub2api",
      outputModes: { sub2api: "merged" },
      textMode: "json",
      includeRefreshToken: true,
      allowSyntheticIdToken: true,
    });
    expect(exported.final).toMatchObject({ type: "previewResult", text: expect.stringContaining("draft-kept") });
  });

  it("keeps file diagnostics visible and preserves them when a concurrent draft is committed", async () => {
    await request({ type: "clear" });
    await request({
      type: "previewText",
      text: '{"platform":"openai","credentials":{"access_token":"draft-account"}}',
    });

    const imported = await request({
      type: "importFiles",
      files: [
        {
          file: new File([
            '{"platform":"openai","credentials":{"access_token":"loaded-account"}}',
          ], "valid.json") as unknown as globalThis.File,
          path: "valid.json",
        },
        {
          file: new File(['{"access_token":}'], "broken.json") as unknown as globalThis.File,
          path: "broken.json",
        },
      ],
    });
    expect(imported.final).toMatchObject({
      type: "importFilesResult",
      summary: { scope: "draft", diagnostics: [{ code: "json_parse_failed", sourceName: "broken.json" }] },
    });

    const committed = await request({ type: "commitDraft" });
    expect(committed.final).toMatchObject({
      type: "commitDraftResult",
      summary: { scope: "loaded", diagnostics: [{ code: "json_parse_failed", sourceName: "broken.json" }] },
    });
  });

  it("previews the selected stable account in JSONL and provider-filtered formats", async () => {
    await request({ type: "clear" });
    await request({
      type: "importFiles",
      files: [{
        file: new File([JSON.stringify([
          { platform: "grok", credentials: { access_token: "xai", user_id: "xai-user" } },
          { platform: "openai", credentials: { access_token: "openai-a", email: "a@example.com" } },
          { platform: "openai", credentials: { access_token: "openai-b", email: "b@example.com" } },
        ])], "mixed.json") as unknown as globalThis.File,
        path: "mixed.json",
      }],
    });
    const range = await request({ type: "range", scope: "loaded", offset: 0, limit: 10, query: "" });
    if (range.final.type !== "rangeResult") throw new Error("expected rangeResult");
    const openAiA = range.final.items.find((item) => item.email === "a@example.com");
    const openAiB = range.final.items.find((item) => item.email === "b@example.com");
    const xai = range.final.items.find((item) => item.provider === "xai");
    if (!openAiA || !openAiB || !xai) throw new Error("expected mixed provider rows");

    const single = await request({
      type: "preview",
      formats: ["codex"],
      previewFormat: "codex",
      outputModes: {},
      textMode: "json",
      selectedAccountId: openAiA.id,
      includeRefreshToken: true,
      allowSyntheticIdToken: true,
    });
    expect(single.final).toMatchObject({ type: "previewResult", shownAccounts: 1, totalAccounts: 1 });
    if (single.final.type !== "previewResult") throw new Error("expected previewResult");
    expect(single.final.text).toContain("openai-a");
    expect(single.final.text).not.toContain("openai-b");

    const unsupported = await request({
      type: "preview",
      formats: ["codex"],
      previewFormat: "codex",
      outputModes: {},
      textMode: "json",
      selectedAccountId: xai.id,
      includeRefreshToken: true,
      allowSyntheticIdToken: true,
    });
    expect(unsupported.final).toMatchObject({
      type: "previewResult",
      text: expect.stringContaining("openai-a"),
      totalAccounts: 1,
      selectedAccountId: openAiA.id,
    });

    const staleJsonl = await request({
      type: "preview",
      formats: ["codex"],
      previewFormat: "codex",
      outputModes: {},
      textMode: "jsonl",
      selectedAccountId: xai.id,
      includeRefreshToken: true,
      allowSyntheticIdToken: true,
    });
    expect(staleJsonl.final).toMatchObject({
      type: "previewResult",
      shownAccounts: 1,
      totalAccounts: 1,
      selectedAccountId: openAiA.id,
      text: expect.stringContaining("openai-a"),
    });
    if (staleJsonl.final.type !== "previewResult") throw new Error("expected previewResult");
    expect(staleJsonl.final.text).not.toContain("openai-b");

    const jsonl = await request({
      type: "preview",
      formats: ["cpa"],
      previewFormat: "cpa",
      outputModes: {},
      textMode: "jsonl",
      selectedAccountId: openAiB.id,
      includeRefreshToken: true,
      allowSyntheticIdToken: true,
    });
    if (jsonl.final.type !== "previewResult") throw new Error("expected previewResult");
    expect(jsonl.final.text.trim().split("\n")).toHaveLength(1);
    expect(jsonl.final.text).toContain("openai-b");
    expect(jsonl.final.text).not.toContain("openai-a");

    await request({ type: "remove", id: openAiB.id });
    const unsupportedWithOneEligibleAccount = await request({
      type: "preview",
      formats: ["codex"],
      previewFormat: "codex",
      outputModes: {},
      textMode: "json",
      selectedAccountId: xai.id,
      includeRefreshToken: true,
      allowSyntheticIdToken: true,
    });
    expect(unsupportedWithOneEligibleAccount.final).toMatchObject({
      type: "previewResult",
      text: expect.stringContaining("openai-a"),
      totalAccounts: 1,
      selectedAccountId: openAiA.id,
    });

    await request({ type: "remove", id: openAiA.id });
    const exactPlan = await request({
      type: "preview",
      formats: ["codex", "grok"],
      previewFormat: "codex",
      outputModes: {},
      textMode: "json",
      selectedAccountId: xai.id,
      includeRefreshToken: true,
      allowSyntheticIdToken: true,
    });
    expect(exactPlan.final).toMatchObject({
      type: "previewResult",
      format: "grok",
      outputPlan: {
        accountCount: 1,
        fileCount: 1,
        formats: ["grok"],
        rejectedAccountCount: 0,
        outputType: "json",
      },
    });
  });

  it("reports per-import dedupe counts and names ZIPs from exported accounts only", async () => {
    await request({ type: "clear" });
    const imported = await request({
      type: "importFiles",
      files: [{
        file: new File([JSON.stringify([
          { platform: "grok", credentials: { access_token: "xai", user_id: "xai-user" } },
          { platform: "openai", credentials: { access_token: "same", email: "first@example.com" } },
          { platform: "openai", credentials: { access_token: "same", refresh_token: "refresh" } },
          { platform: "openai", credentials: { access_token: "second", email: "second@example.com" } },
        ])], "accounts.json") as unknown as globalThis.File,
        path: "accounts.json",
      }],
    });
    expect(imported.final).toMatchObject({
      type: "importFilesResult",
      stats: { processed: 4, added: 3, merged: 1, firstAffectedId: expect.any(String) },
      summary: { loaded: { total: 3 } },
    });
    if (imported.final.type !== "importFilesResult" || !imported.final.stats.firstAffectedId) {
      throw new Error("expected affected account id");
    }
    const removed = await request({ type: "remove", id: imported.final.stats.firstAffectedId });
    expect(removed.final).toMatchObject({
      type: "removeResult",
      suggestedAccountId: expect.any(String),
      summary: { loaded: { total: 2 } },
    });

    const exported = await request({
      type: "export",
      formats: ["codex"],
      outputModes: {},
      textMode: "json",
      includeRefreshToken: true,
      allowSyntheticIdToken: true,
    });
    expect(exported.final).toMatchObject({
      type: "exportResult",
      accountCount: 2,
      mime: "application/zip",
    });
    if (exported.final.type !== "exportResult") throw new Error("expected exportResult");
    expect(exported.final.name).toMatch(/^authconv_2-accounts_/);
  });

  it("keeps disabled verification results, filters through the manifest, and re-verifies in the same Worker", async () => {
    await request({ type: "clear" });
    const imported = await request({
      type: "importFiles",
      verifyTokens: false,
      files: [{
        file: new File([
          '{"platform":"openai","credentials":{"access_token":"opaque-access","email":"opaque@example.com"}}',
        ], "opaque.json") as unknown as globalThis.File,
        path: "opaque.json",
      }],
    });
    expect(imported.final).toMatchObject({
      type: "importFilesResult",
      summary: { loaded: { verificationCounts: { unchecked: 1 } } },
    });

    const blocked = await request({
      type: "preview",
      formats: ["sub2api"],
      previewFormat: "sub2api",
      outputModes: { sub2api: "merged" },
      textMode: "json",
      includeRefreshToken: true,
      allowSyntheticIdToken: true,
      verifyTokens: true,
    });
    expect(blocked.final).toMatchObject({ type: "previewResult", totalAccounts: 0, text: "" });

    const allowed = await request({
      type: "preview",
      formats: ["sub2api"],
      previewFormat: "sub2api",
      outputModes: { sub2api: "merged" },
      textMode: "json",
      includeRefreshToken: true,
      allowSyntheticIdToken: true,
      verifyTokens: false,
    });
    expect(allowed.final).toMatchObject({
      type: "previewResult",
      totalAccounts: 1,
      text: expect.stringContaining("opaque-access"),
    });

    const reverified = await request({ type: "reverify" });
    expect(reverified.messages).toContainEqual(expect.objectContaining({ type: "progress", phase: "verify" }));
    expect(reverified.final).toMatchObject({
      type: "reverifyResult",
      summary: { loaded: { verificationCounts: { unchecked: 0, unverifiable: 1 } } },
    });
    const range = await request({ type: "range", scope: "loaded", offset: 0, limit: 1, query: "" });
    expect(range.final).toMatchObject({
      type: "rangeResult",
      items: [{ tokenVerification: { status: "unverifiable", reason: "opaque_access_token" } }],
    });

    const reused = await request({ type: "reverify" });
    expect(reused.messages).not.toContainEqual(expect.objectContaining({ type: "progress", phase: "verify" }));
    expect(reused.final).toMatchObject({
      type: "reverifyResult",
      summary: { loaded: { total: 1, verificationCounts: { unverifiable: 1 } } },
    });
  });

  it("removes forged Web accounts when verification is enabled", async () => {
    await request({ type: "clear" });
    const imported = await request({
      type: "importFiles",
      verifyTokens: true,
      files: [{
        file: new File([JSON.stringify([
          { platform: "openai", credentials: { access_token: "a.b.c", email: "forged@example.com" } },
          { platform: "openai", credentials: { access_token: "opaque-access", email: "unknown@example.com" } },
        ])], "mixed.json") as unknown as globalThis.File,
        path: "mixed.json",
      }],
    });
    expect(imported.final).toMatchObject({
      type: "importFilesResult",
      summary: {
        loaded: {
          total: 1,
          verificationCounts: { forged: 0, unverifiable: 1 },
        },
      },
      stats: { processed: 2, added: 1 },
    });

    await request({ type: "clear" });
    await request({
      type: "importFiles",
      verifyTokens: false,
      files: [{
        file: new File([
          '{"platform":"openai","credentials":{"access_token":"a.b.c","email":"forged@example.com"}}',
        ], "unchecked.json") as unknown as globalThis.File,
        path: "unchecked.json",
      }],
    });
    const range = await request({ type: "range", scope: "loaded", offset: 0, limit: 1, query: "" });
    if (range.final.type !== "rangeResult") throw new Error("expected rangeResult");
    const reverified = await request({ type: "reverify", selectedAccountId: range.final.items[0].id });
    expect(reverified.final).toMatchObject({
      type: "reverifyResult",
      selectedAccountRemoved: true,
      summary: { loaded: { total: 0, verificationCounts: { forged: 0, unchecked: 0 } } },
    });
  });

  it("re-verifies the accepted draft without parsing it again", async () => {
    await request({ type: "clear" });
    const draft = await request({
      type: "previewText",
      verifyTokens: false,
      text: JSON.stringify([
        { platform: "openai", credentials: { access_token: "a.b.c", email: "forged-draft@example.com" } },
        { platform: "openai", credentials: { access_token: "opaque-draft", email: "unknown-draft@example.com" } },
      ]),
    });
    expect(draft.final).toMatchObject({
      type: "previewTextResult",
      summary: { scope: "draft", active: { total: 2, verificationCounts: { unchecked: 2 } } },
    });

    const reverified = await request({ type: "reverify" });
    expect(reverified.final).toMatchObject({
      type: "reverifyResult",
      summary: {
        scope: "draft",
        active: { total: 2, verificationCounts: { forged: 1, unverifiable: 1, unchecked: 0 } },
      },
    });
    const range = await request({ type: "range", scope: "draft", offset: 0, limit: 10, query: "" });
    expect(range.final).toMatchObject({
      type: "rangeResult",
      total: 2,
      items: [
        { email: "forged-draft@example.com", tokenVerification: { status: "forged" } },
        { email: "unknown-draft@example.com", tokenVerification: { status: "unverifiable" } },
      ],
    });

    const reused = await request({ type: "reverify" });
    expect(reused.messages).not.toContainEqual(expect.objectContaining({ type: "progress", phase: "verify" }));
  });

  it("leaves every stored verification result unchanged when re-verification is cancelled", async () => {
    await request({ type: "clear" });
    const accounts = Array.from({ length: 1_024 }, (_, index) => ({
      platform: "openai",
      credentials: { access_token: `opaque-${index}` },
    }));
    await request({
      type: "importFiles",
      verifyTokens: false,
      files: [{
        file: new File([JSON.stringify(accounts)], "unchecked.json") as unknown as globalThis.File,
        path: "unchecked.json",
      }],
    });

    const reverifyId = post({ type: "reverify" });
    const cancelled = await request({ type: "cancel" });

    expect(await waitForFinal(reverifyId)).toMatchObject({ type: "error", cancelled: true });
    expect(cancelled.final).toMatchObject({
      type: "cancelResult",
      cancelledTask: "reverify",
      summary: { loaded: { verificationCounts: { unchecked: 1_024, unverifiable: 0 } } },
    });
  });
});

function verifiableOpenAiToken(): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return [
    encode({ alg: "RS256", kid: openAiJwks.keys[0].kid }),
    encode({ iss: "https://auth.openai.com", aud: "https://api.openai.com/v1", sub: "verified-user" }),
    Buffer.from("test-signature").toString("base64url"),
  ].join(".");
}

async function request(request: RequestWithoutId): Promise<{ final: WorkerResponse; messages: WorkerResponse[] }> {
  const requestId = post(request);
  const final = await waitForFinal(requestId);
  return { final, messages: responses.filter((message) => message.requestId === requestId) };
}

function post(request: RequestWithoutId): number {
  if (!onMessage) throw new Error("worker listener is not ready");
  const requestId = nextRequestId;
  nextRequestId += 1;
  const needsVerificationSetting = ["previewText", "commitDraft", "importFiles", "preview", "export"].includes(request.type);
  const data = needsVerificationSetting
    ? { ...request, verifyTokens: request.verifyTokens ?? false, requestId }
    : { ...request, requestId };
  onMessage({ data: data as WorkerRequest });
  return requestId;
}

async function waitForFinal(requestId: number): Promise<WorkerResponse> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const final = responses.find((message) => (
      message.requestId === requestId && message.type !== "progress" && message.type !== "exportChunk"
    ));
    if (final) return final;
    if (Date.now() >= deadline) throw new Error(`worker request ${requestId} timed out`);
    await new Promise<void>((resolve) => {
      const wake = () => {
        waiters.delete(wake);
        resolve();
      };
      waiters.add(wake);
      setTimeout(wake, 25);
    });
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
