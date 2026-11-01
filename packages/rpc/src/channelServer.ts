import { VSBuffer } from "./buffer.js";
import { type IDisposable, CancellationTokenSource, toDisposable } from "./foundation.js";
import { BufferReader, BufferWriter, deserialize, serialize } from "./serialization.js";
import type { IMessagePassingProtocol } from "./protocol.js";
import {
  type IChannelServer,
  type IRawResponse,
  type IServerChannel,
  RequestType,
  ResponseType,
} from "./channels.shared.js";

/** channel 注册前暂存的请求；超时/取消/dispose 都是终态，必须把它移出队列并停掉定时器。 */
interface PendingRequestEntry {
  request: any;
  timer: ReturnType<typeof setTimeout>;
}

export class ChannelServer<TContext = string> implements IChannelServer<TContext>, IDisposable {
  private channels = new Map<string, IServerChannel<TContext>>();
  private activeRequests = new Map<number, IDisposable>();
  private pendingRequests = new Map<string, PendingRequestEntry[]>();
  private disposed = false;
  private protocolListener: IDisposable | null;

  constructor(
    private protocol: IMessagePassingProtocol,
    private ctx: TContext,
    private timeoutDelay = 1000,
    private deferInit = false,
  ) {
    this.protocolListener = this.protocol.onMessage((msg) => this.onRawMessage(msg));
    if (!this.deferInit) {
      this.sendResponse({ type: ResponseType.Initialize });
    }
  }

  ready(): void {
    this.sendResponse({ type: ResponseType.Initialize });
  }

  registerChannel(channelName: string, channel: IServerChannel<TContext>): void {
    this.channels.set(channelName, channel);
    setTimeout(() => this.flushPendingRequests(channelName), 0);
  }

  private sendResponse(response: IRawResponse): void {
    switch (response.type) {
      case ResponseType.Initialize:
        this.send([response.type]);
        return;
      case ResponseType.PromiseSuccess:
      case ResponseType.PromiseError:
      case ResponseType.EventFire:
      case ResponseType.EventError:
      case ResponseType.PromiseErrorObj:
        this.send([response.type, response.id], response.data);
        return;
    }
  }

  private send(header: any, body: any = undefined): void {
    // dispose 即终态：此后不再向对端发送任何响应。
    if (this.disposed) {
      return;
    }
    const writer = new BufferWriter();
    serialize(writer, header);
    serialize(writer, body);
    try {
      this.protocol.send(writer.buffer);
    } catch {
      /* noop */
    }
  }

  private onRawMessage(message: VSBuffer): void {
    // 修复原因：同一 protocol 上还有反向 ChannelClient，对方发来的响应也会到这里；原来先解码消息体
    // 再判断类型，每条响应都被完整解码两次。修法：先读消息头，只解码属于本端的请求体。
    const reader = new BufferReader(message);
    const header = deserialize(reader);
    const type = header[0] as RequestType;

    switch (type) {
      case RequestType.Promise:
        this.onPromise({
          type,
          id: header[1],
          channelName: header[2],
          name: header[3],
          arg: deserialize(reader),
        });
        return;
      case RequestType.EventListen:
        this.onEventListen({
          type,
          id: header[1],
          channelName: header[2],
          name: header[3],
          arg: deserialize(reader),
        });
        return;
      case RequestType.PromiseCancel:
      case RequestType.EventDispose:
        // 取消对 pending（channel 尚未注册）与 active 同为终态；只查
        // activeRequests 会把已取消的请求留给迟到的 registerChannel 执行。
        this.removePendingRequestById(header[1]);
        this.disposeActiveRequest(header[1]);
        return;
    }
  }

  private onPromise(request: {
    type: RequestType.Promise;
    id: number;
    channelName: string;
    name: string;
    arg: any;
  }): void {
    const channel = this.channels.get(request.channelName);
    if (!channel) {
      this.collectPendingRequest(request);
      return;
    }

    const cts = new CancellationTokenSource();
    let promise: Promise<any>;

    try {
      promise = channel.call(this.ctx, request.name, request.arg, cts.token);
    } catch (error) {
      promise = Promise.reject(error);
    }

    const disposable = toDisposable(() => cts.cancel());
    this.activeRequests.set(request.id, disposable);

    promise
      .then(
        (data) => {
          this.sendResponse({
            id: request.id,
            data,
            type: ResponseType.PromiseSuccess,
          });
        },
        (error) => {
          if (error instanceof Error) {
            const rpcErrorPayload: {
              message: string;
              name: string;
              stack: string[] | undefined;
              code?: unknown;
              kind?: unknown;
              status?: unknown;
              retryAfterMs?: unknown;
              data?: unknown;
              detail?: unknown;
              details?: unknown;
              taskId?: unknown;
              traceId?: unknown;
              retryable?: unknown;
              profileId?: unknown;
            } = {
              message: error.message,
              name: error.name,
              stack: error.stack ? error.stack.split("\n") : undefined,
            };
            const errorRecord = error as Error & Record<string, unknown>;
            const passthroughKeys = [
              "code",
              "kind",
              "status",
              "retryAfterMs",
              "data",
              "detail",
              "details",
              "taskId",
              "traceId",
              "retryable",
              // Bug 原因：Host 的远程等待点（需要安装/升级、补凭据）用 profileId 指明实际操作线路；
              // 旧白名单丢掉它，侧栏项目只能把不含凭据的目标交给向导，确认安装后报“SSH 认证失败”。
              "profileId",
            ] as const;
            for (const key of passthroughKeys) {
              const value = errorRecord[key];
              if (value !== undefined) {
                rpcErrorPayload[key] = value;
              }
            }
            this.sendResponse({
              id: request.id,
              data: rpcErrorPayload,
              type: ResponseType.PromiseError,
            });
            return;
          }

          this.sendResponse({
            id: request.id,
            data: error,
            type: ResponseType.PromiseErrorObj,
          });
        },
      )
      .finally(() => {
        disposable.dispose();
        this.activeRequests.delete(request.id);
      });
  }

  private onEventListen(request: {
    type: RequestType.EventListen;
    id: number;
    channelName: string;
    name: string;
    arg: any;
  }): void {
    const channel = this.channels.get(request.channelName);
    if (!channel) {
      this.collectPendingRequest(request);
      return;
    }

    try {
      const disposable = channel.listen(
        this.ctx,
        request.name,
        request.arg,
      )((data) => {
        this.sendResponse({
          id: request.id,
          data,
          type: ResponseType.EventFire,
        });
      });
      this.activeRequests.set(request.id, disposable);
    } catch (error) {
      // 已结束的终端等资源会拒绝迟到订阅；该拒绝属于本次请求，不能逃逸并退出整个 Host。
      // 独立失败帧不会被旧客户端当作业务事件，也不会建立无法释放的活动订阅。
      this.sendResponse({
        id: request.id,
        type: ResponseType.EventError,
        data: {
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
          ...(error instanceof Error && error.stack ? { stack: error.stack.split("\n") } : {}),
        },
      });
    }
  }

  private disposeActiveRequest(id: number): void {
    const disposable = this.activeRequests.get(id);
    if (!disposable) {
      return;
    }
    disposable.dispose();
    this.activeRequests.delete(id);
  }

  private collectPendingRequest(request: any): void {
    const pendingRequests = this.pendingRequests.get(request.channelName) ?? [];
    if (pendingRequests.length === 0) {
      this.pendingRequests.set(request.channelName, pendingRequests);
    }

    // 修复原因：超时定时器必须先把条目移出队列再回终态帧。旧实现只回 PromiseError
    // 且不移除，已失败的请求会在迟到的 registerChannel 里被再次执行；而 EventListen
    // 若只删队列不回帧，会把"等 channel 注册"变成永久静默死订阅（客户端监听器无人终结）。
    const entry: PendingRequestEntry = {
      request,
      timer: setTimeout(() => {
        this.removePendingEntry(request.channelName, entry);
        console.error(`Unknown channel: ${request.channelName}`);
        if (request.type === RequestType.Promise) {
          this.sendResponse({
            id: request.id,
            data: {
              name: "Unknown channel",
              message: `Channel name '${request.channelName}' timed out after ${this.timeoutDelay}ms`,
              stack: undefined,
            },
            type: ResponseType.PromiseError,
          });
          return;
        }
        // EventListen 超时复用 EventError 终结该次订阅周期（客户端释放监听器，可重新
        // 订阅；旧客户端忽略未知 205 响应，见 docs/architecture/rpc.md Layer 3）。
        this.sendResponse({
          id: request.id,
          type: ResponseType.EventError,
          data: {
            name: "Unknown channel",
            message: `Channel name '${request.channelName}' timed out after ${this.timeoutDelay}ms`,
          },
        });
      }, this.timeoutDelay),
    };

    pendingRequests.push(entry);
  }

  private removePendingEntry(channelName: string, entry: PendingRequestEntry): void {
    const pendingRequests = this.pendingRequests.get(channelName);
    if (!pendingRequests) {
      return;
    }
    const index = pendingRequests.indexOf(entry);
    if (index < 0) {
      return;
    }
    pendingRequests.splice(index, 1);
    if (pendingRequests.length === 0) {
      this.pendingRequests.delete(channelName);
    }
  }

  private removePendingRequestById(id: number): void {
    for (const [channelName, entries] of this.pendingRequests) {
      const index = entries.findIndex((pendingEntry) => pendingEntry.request.id === id);
      if (index < 0) {
        continue;
      }
      const [entry] = entries.splice(index, 1);
      clearTimeout(entry.timer);
      if (entries.length === 0) {
        this.pendingRequests.delete(channelName);
      }
      // 同一连接的请求 id 单调递增且唯一，命中即结束。
      return;
    }
  }

  private flushPendingRequests(channelName: string): void {
    // registerChannel 的 flush 经 setTimeout 0 延迟，可能晚于 dispose 到达。
    if (this.disposed) {
      return;
    }
    const requests = this.pendingRequests.get(channelName);
    if (!requests) {
      return;
    }

    for (const { request, timer } of requests) {
      clearTimeout(timer);
      switch (request.type) {
        case RequestType.Promise:
          this.onPromise(request);
          break;
        case RequestType.EventListen:
          this.onEventListen(request);
          break;
      }
    }
    this.pendingRequests.delete(channelName);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.protocolListener?.dispose();
    this.protocolListener = null;
    for (const disposable of this.activeRequests.values()) {
      disposable.dispose();
    }
    this.activeRequests.clear();
    // dispose 后 pending 请求不得执行也不得回包：清空队列并停掉全部定时器。
    for (const entries of this.pendingRequests.values()) {
      for (const { timer } of entries) {
        clearTimeout(timer);
      }
    }
    this.pendingRequests.clear();
  }
}
