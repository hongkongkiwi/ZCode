/* eslint-disable max-lines -- 分片构建与手机端重组状态机共享同一组物理不变量，集中在单一模块便于对照。 */
import {
  WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS,
} from "./web-remote-control-rpc-transport.js";
import type {
  WebRemoteControlAppPayloadFragmentPayload,
  WebRemoteControlRelayDataMessage,
} from "./web-remote-control.js";

const utf8Encoder = new TextEncoder();

/**
 * app payload（bootstrap-response / workspace-list-updated 等）此前超过单帧
 * maxPhysicalFrameBytes 即被桌面端整体丢弃：payload 随工作区/任务数量自然增长，
 * 一旦越过 1MiB，手机端 bootstrap 永远等不到响应（desktop-bootstrap-timeout）。
 * 这里按 relay 单帧上限做透明分片，与 rpc-frame 共用同一组限额常量。
 */
export const WEB_REMOTE_CONTROL_APP_PAYLOAD_FRAGMENT_OVERHEAD_RESERVE = 512;

export interface WebRemoteControlAppPayloadFragmentEnvelope {
  readonly message: WebRemoteControlRelayDataMessage<WebRemoteControlAppPayloadFragmentPayload>;
  readonly json: string;
  readonly bytes: number;
}

export type FragmentAppPayloadFailure = "message-too-large" | "too-many-fragments";

export type FragmentAppPayloadResult =
  | {
      kind: "fragmented";
      envelopes: WebRemoteControlAppPayloadFragmentEnvelope[];
      payloadBytes: number;
      fragmentCount: number;
    }
  | { kind: "rejected"; reason: FragmentAppPayloadFailure; payloadBytes: number };

function measureUtf8Bytes(text: string): number {
  return utf8Encoder.encode(text).byteLength;
}

function buildFragmentEnvelope(
  payload: Omit<WebRemoteControlAppPayloadFragmentPayload, "zcode_type">,
): WebRemoteControlAppPayloadFragmentEnvelope {
  const message: WebRemoteControlRelayDataMessage<WebRemoteControlAppPayloadFragmentPayload> = {
    type: "data",
    payload: { zcode_type: "app-payload-fragment", ...payload },
    client_ts: Date.now(),
  };
  const json = JSON.stringify(message);
  return Object.freeze({ message, json, bytes: measureUtf8Bytes(json) });
}

/**
 * 把一个已序列化的 app payload JSON（payload 本身，不含 relay envelope）切成
 * 每帧 ≤ maxPhysicalFrameBytes 的分片 envelope 序列。fragmentText 是 payload
 * JSON 的 UTF-16 码元切片，拼接即无损还原；重组端用 payloadBytes（UTF-8 字节数）
 * 做完整性校验。
 */
export function fragmentAppPayloadJson(
  payloadJson: string,
  transferId: string,
): FragmentAppPayloadResult {
  const payloadBytes = measureUtf8Bytes(payloadJson);
  if (payloadBytes > WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxMessageBytes) {
    return { kind: "rejected", reason: "message-too-large", payloadBytes };
  }
  const envelopes: WebRemoteControlAppPayloadFragmentEnvelope[] = [];
  // 首刀按 4 字节/字符保守估（UTF-8 最坏密度），量出实际密度后再放大，
  // 保证 ASCII 为主的真实 payload 不会被切成三倍数量的分片。
  const conservativeChars = Math.max(
    1,
    Math.floor(
      (WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes -
        WEB_REMOTE_CONTROL_APP_PAYLOAD_FRAGMENT_OVERHEAD_RESERVE) /
        4,
    ),
  );
  let cursor = 0;
  while (cursor < payloadJson.length) {
    const remainingChars = payloadJson.length - cursor;
    let chars = Math.min(remainingChars, conservativeChars);
    let envelope = buildFragmentEnvelope({
      transferId,
      fragmentIndex: envelopes.length,
      // fragmentCount 只是占位：切片循环结束后回填真实值并重算 bytes。
      fragmentCount: 1,
      payloadBytes,
      fragmentText: payloadJson.slice(cursor, cursor + chars),
    });
    if (envelope.bytes > WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes) {
      // 转义/高密度字符导致超限：按实测密度收缩，必要时二分到单字符。
      let shrunkChars = Math.max(
        1,
        Math.floor(
          (chars * WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes) / envelope.bytes,
        ),
      );
      while (shrunkChars >= 1) {
        envelope = buildFragmentEnvelope({
          transferId,
          fragmentIndex: envelopes.length,
          fragmentCount: 1,
          payloadBytes,
          fragmentText: payloadJson.slice(cursor, cursor + shrunkChars),
        });
        if (envelope.bytes <= WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes) {
          break;
        }
        shrunkChars = Math.floor(shrunkChars / 2);
      }
      if (envelope.bytes > WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes) {
        return { kind: "rejected", reason: "message-too-large", payloadBytes };
      }
      chars = shrunkChars;
    } else if (chars < remainingChars) {
      // 密度低于保守假设：按实测密度放大一次，减少分片数量。
      const grownChars = Math.min(
        remainingChars,
        Math.floor(
          (chars * (WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes - 64)) /
            envelope.bytes,
        ),
      );
      if (grownChars > chars) {
        const grown = buildFragmentEnvelope({
          transferId,
          fragmentIndex: envelopes.length,
          fragmentCount: 1,
          payloadBytes,
          fragmentText: payloadJson.slice(cursor, cursor + grownChars),
        });
        if (grown.bytes <= WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes) {
          chars = grownChars;
          envelope = grown;
        }
      }
    }
    envelopes.push(envelope);
    cursor += chars;
  }
  if (envelopes.length > WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxFragments) {
    return { kind: "rejected", reason: "too-many-fragments", payloadBytes };
  }
  const fragmentCount = envelopes.length;
  const finalEnvelopes = envelopes.map((envelope, index) =>
    envelope.message.payload.fragmentCount === fragmentCount
      ? envelope
      : buildFragmentEnvelope({
          transferId,
          fragmentIndex: index,
          fragmentCount,
          payloadBytes,
          fragmentText: envelope.message.payload.fragmentText,
        }),
  );
  return { kind: "fragmented", envelopes: finalEnvelopes, payloadBytes, fragmentCount };
}

interface ActiveFragmentTransfer {
  readonly fragmentCount: number;
  readonly payloadBytes: number;
  fragments: (string | undefined)[];
  received: number;
  timer: ReturnType<typeof setTimeout>;
}

export interface WebRemoteControlAppPayloadAssemblerOptions {
  /** 重组完成的逻辑 payload（已经过 JSON.parse），由调用方再做 schema 校验与路由。 */
  deliver: (payload: unknown) => void;
}

/**
 * 手机端重组器：relay 是有序可靠 TCP 通道，fragmentIndex/fragmentCount 足以还原；
 * transferId 防止与其它 data 消息交错混淆，payloadBytes 提供无 CRC 的完整性校验。
 * 未识别/非法/重复分片一律静默丢弃，超时与容量上限防内存膨胀。
 */
export class WebRemoteControlAppPayloadAssembler {
  private readonly transfers = new Map<string, ActiveFragmentTransfer>();

  constructor(private readonly options: WebRemoteControlAppPayloadAssemblerOptions) {}

  /** 返回 true 表示该 payload 已按分片处理（无论合法与否），调用方不应再走普通路由。 */
  ingest(candidate: unknown): boolean {
    if (!candidate || typeof candidate !== "object") {
      return false;
    }
    const record = candidate as Record<string, unknown>;
    if (record.zcode_type !== "app-payload-fragment") {
      return false;
    }
    const transferId = record.transferId;
    const fragmentIndex = record.fragmentIndex;
    const fragmentCount = record.fragmentCount;
    const payloadBytes = record.payloadBytes;
    const fragmentText = record.fragmentText;
    if (
      typeof transferId !== "string" ||
      transferId.length === 0 ||
      transferId.length > 128 ||
      typeof fragmentIndex !== "number" ||
      !Number.isInteger(fragmentIndex) ||
      typeof fragmentCount !== "number" ||
      !Number.isInteger(fragmentCount) ||
      fragmentCount < 1 ||
      fragmentCount > WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxFragments ||
      fragmentIndex < 0 ||
      fragmentIndex >= fragmentCount ||
      typeof payloadBytes !== "number" ||
      !Number.isInteger(payloadBytes) ||
      payloadBytes < 1 ||
      payloadBytes > WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxMessageBytes ||
      typeof fragmentText !== "string" ||
      fragmentText.length === 0 ||
      measureUtf8Bytes(fragmentText) >
        WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes
    ) {
      return true;
    }
    let transfer = this.transfers.get(transferId);
    if (!transfer) {
      // 桌面端按顺序发送，正常情况下同时只有一个活跃 transfer；
      // 容量上限防异常发送端把重组器撑爆，逐出最旧的半途 transfer。
      while (this.transfers.size >= 4) {
        const oldest = this.transfers.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        this.disposeTransfer(oldest);
      }
      transfer = {
        fragmentCount,
        payloadBytes,
        fragments: Array.from({ length: fragmentCount }, () => undefined as string | undefined),
        received: 0,
        timer: setTimeout(() => {
          this.disposeTransfer(transferId);
        }, WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.assemblyTimeoutMs),
      };
      this.transfers.set(transferId, transfer);
    } else if (
      transfer.fragmentCount !== fragmentCount ||
      transfer.payloadBytes !== payloadBytes
    ) {
      // 同一 transferId 元数据冲突：视为异常发送端，丢弃整个 transfer。
      this.disposeTransfer(transferId);
      return true;
    }
    if (transfer.fragments[fragmentIndex] !== undefined) {
      return true;
    }
    transfer.fragments[fragmentIndex] = fragmentText;
    transfer.received += 1;
    if (transfer.received < transfer.fragmentCount) {
      return true;
    }
    this.disposeTransfer(transferId);
    const joined = transfer.fragments.join("");
    if (measureUtf8Bytes(joined) !== payloadBytes) {
      return true;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(joined);
    } catch {
      return true;
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as Record<string, unknown>).zcode_type === "app-payload-fragment"
    ) {
      // 不允许分片套分片。
      return true;
    }
    this.options.deliver(parsed);
    return true;
  }

  /** 丢弃所有半途 transfer（socket 断开/重连时调用），重组器本身可继续复用。 */
  dispose(): void {
    // Map 迭代期间删除当前 key 是安全的。
    for (const transferId of this.transfers.keys()) {
      this.disposeTransfer(transferId);
    }
  }

  private disposeTransfer(transferId: string): void {
    const transfer = this.transfers.get(transferId);
    if (!transfer) {
      return;
    }
    clearTimeout(transfer.timer);
    this.transfers.delete(transferId);
  }
}
