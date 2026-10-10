import { afterEach, describe, expect, it, vi } from "vitest";
import { WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS } from "../src/web-remote-control-rpc-transport.js";
import {
  WebRemoteControlAppPayloadAssembler,
  fragmentAppPayloadJson,
} from "../src/web-remote-control-fragmentation.js";

function buildOversizePayloadJson(targetBytes: number): string {
  // 混入多字节字符、引号与反斜杠，覆盖 JSON-in-JSON 转义膨胀与 UTF-8 密度差异。
  const createJson = (filler: string) =>
    JSON.stringify({
      zcode_type: "workspace-list-updated",
      result: { workspaces: [{ name: `中🙂"/\\${filler}` }] },
    });
  const base = createJson("");
  const paddingBytes = targetBytes - Buffer.byteLength(base, "utf8");
  if (paddingBytes < 0) throw new Error("target smaller than fixed envelope");
  return createJson("x".repeat(paddingBytes));
}

describe("fragmentAppPayloadJson", () => {
  it("splits an oversize payload into single-frame envelopes that reassemble losslessly", () => {
    const payloadJson = buildOversizePayloadJson(
      WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes + 128 * 1024,
    );
    const result = fragmentAppPayloadJson(payloadJson, "transfer-1");
    if (result.kind !== "fragmented") {
      throw new Error(`expected fragmented, got ${result.kind}`);
    }
    expect(result.fragmentCount).toBeGreaterThanOrEqual(2);
    for (const envelope of result.envelopes) {
      expect(envelope.bytes).toBeLessThanOrEqual(
        WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes,
      );
      expect(envelope.message.type).toBe("data");
      expect(envelope.message.payload.transferId).toBe("transfer-1");
      expect(typeof envelope.message.payload.fragmentText).toBe("string");
    }
    const joined = result.envelopes
      .map((envelope) => envelope.message.payload.fragmentText)
      .join("");
    expect(joined).toBe(payloadJson);
    expect(result.envelopes.map((envelope) => envelope.message.payload.fragmentIndex)).toEqual(
      result.envelopes.map((_, index) => index),
    );
    for (const envelope of result.envelopes) {
      expect(envelope.message.payload.fragmentCount).toBe(result.fragmentCount);
      expect(envelope.message.payload.payloadBytes).toBe(result.payloadBytes);
    }
  });

  it("rejects payloads beyond maxMessageBytes", () => {
    const payloadJson = JSON.stringify({
      zcode_type: "app-error",
      reason: "unexpected-error",
      error: "x".repeat(WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxMessageBytes),
    });
    const result = fragmentAppPayloadJson(payloadJson, "transfer-too-large");
    expect(result).toMatchObject({ kind: "rejected", reason: "message-too-large" });
  });

  it("keeps single-fragment output for payloads that still fit one frame", () => {
    const payloadJson = JSON.stringify({
      zcode_type: "app-error",
      reason: "unexpected-error",
      error: "bounded",
    });
    const result = fragmentAppPayloadJson(payloadJson, "transfer-small");
    expect(result).toMatchObject({ kind: "fragmented", fragmentCount: 1 });
  });
});

describe("WebRemoteControlAppPayloadAssembler", () => {
  function ingestJson(
    assembler: WebRemoteControlAppPayloadAssembler,
    payloadJson: string,
    transferId = "transfer-1",
  ): FragmentResult {
    const result = fragmentAppPayloadJson(payloadJson, transferId);
    if (result.kind !== "fragmented") {
      throw new Error(`expected fragmented, got ${result.kind}`);
    }
    for (const envelope of result.envelopes) {
      assembler.ingest(envelope.message.payload);
    }
    return { result, envelopeCount: result.envelopes.length };
  }
  type FragmentResult = { result: { payloadBytes: number }; envelopeCount: number };

  it("delivers the logical payload once all fragments arrive", () => {
    const delivered: unknown[] = [];
    const assembler = new WebRemoteControlAppPayloadAssembler({
      deliver: (payload) => delivered.push(payload),
    });
    const payloadJson = buildOversizePayloadJson(
      WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes + 64 * 1024,
    );
    const expected = JSON.parse(payloadJson);
    const ingested = ingestJson(assembler, payloadJson);
    expect(ingested.envelopeCount).toBeGreaterThanOrEqual(2);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toEqual(expected);
    assembler.dispose();
  });

  it("returns false for non-fragment candidates and true for invalid fragments", () => {
    const delivered: unknown[] = [];
    const assembler = new WebRemoteControlAppPayloadAssembler({
      deliver: (payload) => delivered.push(payload),
    });
    expect(assembler.ingest({ zcode_type: "bootstrap-response" })).toBe(false);
    expect(assembler.ingest(null)).toBe(false);
    expect(assembler.ingest("text")).toBe(false);
    expect(
      assembler.ingest({
        zcode_type: "app-payload-fragment",
        transferId: "t",
        fragmentIndex: 9,
        fragmentCount: 2,
        payloadBytes: 8,
        fragmentText: "abc",
      }),
    ).toBe(true);
    expect(
      assembler.ingest({
        zcode_type: "app-payload-fragment",
        transferId: "t",
        fragmentIndex: 0,
        fragmentCount: 2,
        payloadBytes: WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxMessageBytes + 1,
        fragmentText: "abc",
      }),
    ).toBe(true);
    expect(delivered).toHaveLength(0);
    assembler.dispose();
  });

  it("ignores duplicate fragments instead of double-counting them", () => {
    const delivered: unknown[] = [];
    const assembler = new WebRemoteControlAppPayloadAssembler({
      deliver: (payload) => delivered.push(payload),
    });
    const payloadJson = buildOversizePayloadJson(
      WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes + 64 * 1024,
    );
    const result = fragmentAppPayloadJson(payloadJson, "transfer-dup");
    if (result.kind !== "fragmented") throw new Error("expected fragmented");
    const first = result.envelopes[0];
    if (!first) throw new Error("expected at least one envelope");
    assembler.ingest(first.message.payload);
    assembler.ingest(first.message.payload);
    const deliveredAfterDuplicate = delivered.length;
    for (const envelope of result.envelopes) {
      assembler.ingest(envelope.message.payload);
    }
    expect(deliveredAfterDuplicate).toBe(0);
    expect(delivered).toHaveLength(1);
    assembler.dispose();
  });

  it("drops transfers that time out before completion", () => {
    vi.useFakeTimers();
    try {
      const delivered: unknown[] = [];
      const assembler = new WebRemoteControlAppPayloadAssembler({
        deliver: (payload) => delivered.push(payload),
      });
      const payloadJson = buildOversizePayloadJson(
        WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes + 64 * 1024,
      );
      const result = fragmentAppPayloadJson(payloadJson, "transfer-timeout");
      if (result.kind !== "fragmented") throw new Error("expected fragmented");
      const first = result.envelopes[0];
      const straggler = result.envelopes[1];
      if (!first || !straggler) throw new Error("expected at least two envelopes");
      assembler.ingest(first.message.payload);
      vi.advanceTimersByTime(WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.assemblyTimeoutMs + 1_000);
      // 超时后仅残片到达：重组器不会完成投递（桌面端稍后会用新 transferId 完整重发）。
      assembler.ingest(straggler.message.payload);
      expect(delivered).toHaveLength(0);
      assembler.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps interleaved transfers independent and drops payloadBytes mismatches", () => {
    const delivered: unknown[] = [];
    const assembler = new WebRemoteControlAppPayloadAssembler({
      deliver: (payload) => delivered.push(payload),
    });
    const first = fragmentAppPayloadJson(
      buildOversizePayloadJson(
        WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes + 32 * 1024,
      ),
      "transfer-a",
    );
    const second = fragmentAppPayloadJson(
      buildOversizePayloadJson(
        WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes + 96 * 1024,
      ),
      "transfer-b",
    );
    if (first.kind !== "fragmented" || second.kind !== "fragmented") {
      throw new Error("expected fragmented");
    }
    assembler.ingest(first.envelopes[0]?.message.payload);
    assembler.ingest(second.envelopes[0]?.message.payload);
    assembler.ingest(first.envelopes[1]?.message.payload);
    assembler.ingest(second.envelopes[1]?.message.payload);
    expect(delivered).toHaveLength(2);
    const corrupted = fragmentAppPayloadJson(
      buildOversizePayloadJson(
        WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes + 16 * 1024,
      ),
      "transfer-c",
    );
    if (corrupted.kind !== "fragmented") throw new Error("expected fragmented");
    const lastCorrupted = corrupted.envelopes[corrupted.envelopes.length - 1];
    if (!lastCorrupted) throw new Error("expected at least two envelopes");
    assembler.ingest({
      ...lastCorrupted.message.payload,
      fragmentText: `${lastCorrupted.message.payload.fragmentText}x`,
    });
    for (const envelope of corrupted.envelopes) {
      assembler.ingest(envelope.message.payload);
    }
    expect(delivered).toHaveLength(2);
    assembler.dispose();
  });

  it("drops transfers whose reassembly is not valid JSON and allows reuse after dispose", () => {
    const delivered: unknown[] = [];
    const assembler = new WebRemoteControlAppPayloadAssembler({
      deliver: (payload) => delivered.push(payload),
    });
    assembler.ingest({
      zcode_type: "app-payload-fragment",
      transferId: "transfer-json",
      fragmentIndex: 0,
      fragmentCount: 1,
      payloadBytes: Buffer.byteLength('{"zcode_type":"app-error"', "utf8"),
      fragmentText: '{"zcode_type":"app-error"',
    });
    expect(delivered).toHaveLength(0);
    assembler.dispose();
    const payloadJson = JSON.stringify({
      zcode_type: "app-error",
      reason: "unexpected-error",
      error: "after-dispose",
    });
    const result = fragmentAppPayloadJson(payloadJson, "transfer-after-dispose");
    if (result.kind !== "fragmented") throw new Error("expected fragmented");
    for (const envelope of result.envelopes) {
      assembler.ingest(envelope.message.payload);
    }
    expect(delivered).toHaveLength(1);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
