import { describe, expect, it } from "vitest";
import type { YuanhengConnectionStatus } from "@/lib/api/yuanheng";
import { buildTraeSetupPreview, traeApiFormats } from "@/lib/traeSetup";

export const traeTestConnection = (): YuanhengConnectionStatus => ({
  connected: true,
  baseUrl: "https://meta-api.vip",
  userId: "synthetic-user",
  account: null,
  models: ["astra", "text-other", "image-only"],
  terminalModels: ["astra", "text-other"],
  imageGenerationModels: ["image-only"],
  groups: [
    { id: "premium", description: "", ratio: 1 },
    { id: "standard", description: "", ratio: 0.5 },
  ],
  modelGroups: {
    astra: ["premium"],
    "text-other": ["standard"],
    "image-only": ["premium"],
  },
  reasoningLevels: {},
  announcement: null,
  lastSyncedAt: 1,
});
const selection = { model: "astra", group: "premium" };

describe("TRAE official Full URL setup preview", () => {
  it("offers the verified China protocols without moving the token to a different host", () => {
    expect(traeApiFormats("china").map((entry) => entry.value)).toEqual([
      "openai-chat",
      "openai-responses",
      "anthropic-messages",
    ]);
    expect(
      buildTraeSetupPreview(
        traeTestConnection(),
        selection,
        "openai-responses",
        "china",
      ),
    ).toMatchObject({
      ready: true,
      requestUrl: "https://meta-api.vip/v1/responses",
    });
    for (const format of traeApiFormats("china")) {
      expect(
        buildTraeSetupPreview(
          traeTestConnection(),
          selection,
          format.value,
          "china",
        ),
      ).toMatchObject({
        ready: true,
        requestUrl: `https://meta-api.vip${format.path}`,
      });
    }
  });
  it.each([
    ["openai-chat", "OpenAI Chat Completions", "/v1/chat/completions"],
    ["openai-responses", "OpenAI Responses API", "/v1/responses"],
    ["anthropic-messages", "Anthropic Messages", "/v1/messages"],
  ])(
    "builds %s without duplicating v1 or switching origins",
    (format, label, path) => {
      for (const host of ["meta-api.com", "meta-api.vip", "cn.meta-api.vip"]) {
        for (const suffix of ["", "/", "/v1", "/v1/"]) {
          const connection = {
            ...traeTestConnection(),
            baseUrl: `https://${host}${suffix}`,
          };
          expect(buildTraeSetupPreview(connection, selection, format)).toEqual({
            ready: true,
            ...selection,
            apiFormat: label,
            requestUrl: `https://${host}${path}`,
            tokenPageUrl: `https://${host}/console/token`,
          });
        }
      }
    },
  );

  it.each([
    "https://meta-api.com.evil.test",
    "https://meta-api.com@evil.test",
    "https://user:secret@meta-api.com",
    "https://meta-api.com:444",
    "https://meta-api.com?key=secret",
    "https://meta-api.com/unknown",
    "http://meta-api.vip",
    "https://meta-api.vip.evil.test",
    "https://meta-api.vip@evil.test",
    "https://user:secret@meta-api.vip",
    "https://user@meta-api.vip",
    "https://meta-api.vip:444",
    "https://meta-api.vip?key=secret",
    "https://meta-api.vip#secret",
    "https://meta-api.vip?",
    "https://meta-api.vip#",
    "https://meta-api.vip/v1/messages",
    "https://meta-api.vip/unknown",
    "https://127.0.0.1:15721",
    "https://meta-api.vip\\evil",
    " https://meta-api.vip",
    "https://meta-api.vip\n",
  ])(
    "does not offer credential entry at an unverified address: %s",
    (baseUrl) => {
      expect(
        buildTraeSetupPreview(
          { ...traeTestConnection(), baseUrl },
          selection,
          "openai-chat",
        ),
      ).toEqual({ ready: false, reason: "origin" });
    },
  );

  it("requires an authenticated account and an explicit model/group pair", () => {
    expect(buildTraeSetupPreview(undefined, selection, "openai-chat")).toEqual({
      ready: false,
      reason: "connection",
    });
    for (const patch of [
      { connected: false },
      { userId: null },
      { userId: "" },
    ]) {
      expect(
        buildTraeSetupPreview(
          { ...traeTestConnection(), ...patch },
          selection,
          "openai-chat",
        ),
      ).toEqual({ ready: false, reason: "connection" });
    }
    expect(
      buildTraeSetupPreview(traeTestConnection(), undefined, "openai-chat"),
    ).toEqual({ ready: false, reason: "selection" });
  });

  it.each([
    { model: "astra", group: "standard" },
    { model: "unknown", group: "premium" },
    { model: "image-only", group: "premium" },
    { model: "astra", group: "unknown" },
  ])("rejects a stale or unrelated pair: %j", (pair) => {
    expect(
      buildTraeSetupPreview(traeTestConnection(), pair, "openai-chat"),
    ).toEqual({ ready: false, reason: "catalog" });
  });

  it("rejects revoked group mappings, malicious line breaks and unknown protocols", () => {
    const connection = traeTestConnection();
    connection.modelGroups.astra = [];
    expect(buildTraeSetupPreview(connection, selection, "openai-chat")).toEqual(
      { ready: false, reason: "catalog" },
    );
    const unsafe = "astra\nAPI Key: untrusted";
    connection.terminalModels = [unsafe];
    connection.modelGroups[unsafe] = ["premium"];
    expect(
      buildTraeSetupPreview(
        connection,
        { ...selection, model: unsafe },
        "openai-chat",
      ),
    ).toEqual({ ready: false, reason: "catalog" });
    expect(
      buildTraeSetupPreview(traeTestConnection(), selection, "invented-format"),
    ).toEqual({ ready: false, reason: "protocol" });
  });

  it("does not mutate the connection or include any credential data", () => {
    const connection = traeTestConnection();
    const before = structuredClone(connection);
    const preview = buildTraeSetupPreview(connection, selection, "openai-chat");
    expect(connection).toEqual(before);
    expect(Object.keys(preview).sort()).toEqual([
      "apiFormat",
      "group",
      "model",
      "ready",
      "requestUrl",
      "tokenPageUrl",
    ]);
  });
});
