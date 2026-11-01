# RPC Channel 初始化时序与 "Unknown channel" 问题

## 问题现象

Remote 模式下，窗口打开时报错：

```
[DirectoryBrowser] 获取系统信息失败: Unknown channel: Channel name 'system'
timed out after 1000ms
```

## ChannelClient 状态迁移

```
Uninitialized ──[收到 Initialize(200)]──→ Idle ──[发送请求]──→ Idle（保持）
```

- **Uninitialized**：还没收到服务端 Initialize，所有请求自动排队（`whenInitialized()`），不会超时
- **Idle**：已收到 Initialize，请求立即发出

## 完整通信流程

### Local 模式（正常）

```
Main Process                    Host Utility Process              Renderer
───────────                     ─────────────────                 ────────
fork host process ──────────→
                                parentPort.on("message")
                                  new ChannelServer()
                                  ├── 立即发 Initialize ──────────→ 收到 Initialize
                                  ├── state → Idle                   ChannelClient: Uninitialized → Idle
                                  │
                                  createLocalServices()  (同步)
                                  exposeOnChannelServer()  (同步)
                                  注册 file/system/terminal/...
                                                                     DirectoryBrowser mounts
                                                                     useEffect → systemService.info()
                                                                     RPC 请求发出 ← ─ ─ ─ ─ ─ ─ ─ ─ ─
                                                                  ← ─ system channel 已注册，直接处理
                                                                     返回结果 ──────────────────────→
```

**没问题**：`Initialize` 发完后，`registerChannel` 马上同步执行。Renderer 收到 `Initialize` 发请求时，channel 已经注册好了。

### Remote 模式（有 bug）

```
Main Process                    Host Utility Process              Renderer
───────────                     ─────────────────                 ────────
fork host process ──────────→
                                parentPort.on("message")
                                  new ChannelServer()
                                  ├── 立即发 Initialize ──────────→ 收到 Initialize
                                  │                                 ChannelClient: Uninitialized → Idle
                                  │
                                  await setupRemoteConnection()     DirectoryBrowser mounts
                                    (SSH 建连，可能 2~5 秒)        useEffect → systemService.info()
                                  │                                 RPC 请求发出 ─ ─ ─ ─ ─ ─ ─ ─ ─ →
                                  │                                 system channel 不存在！
                                  │                                 进入 pendingRequests 队列
                                  │                                 设 1000ms 超时定时器
                                  │
                                  │                                 ─── 1000ms 后 ───
                                  │                                 超时！报错:
                                  │                                 "Unknown channel: 'system'"
                                  │
                                  ... SSH 还在连接中 ...
                                  │
                                  services.exposeOnChannelServer()
                                  registerChannel("system", ...)    ← 太晚了，请求已超时
```

**根因**：`ChannelServer` 构造时就发了 `Initialize`，renderer 以为服务端已就绪，立即发请求。但 SSH 还没连完，`system` channel 还没注册，1000ms 超时。

### 修复后的 Remote 模式

```
Main Process                    Host Utility Process              Renderer
───────────                     ─────────────────                 ────────
fork host process ──────────→
                                parentPort.on("message")
                                  new ChannelServer(deferInit=true)
                                  ├── 不发 Initialize
                                  │                                 ChannelClient: 保持 Uninitialized
                                  │
                                  await setupRemoteConnection()
                                    (SSH 建连，可能 2~5 秒)        DirectoryBrowser mounts
                                  │                                 useEffect → systemService.info()
                                  │                                 ChannelClient 还在 Uninitialized
                                  │                                 请求自动排队等 Initialize（不会超时）
                                  │
                                  services.exposeOnChannelServer()
                                  registerChannel("system", ...)
                                  server.ready() ─── 发 Initialize → 收到 Initialize
                                                                     ChannelClient: Uninitialized → Idle
                                                                     排队的请求立即发出 ─ ─ ─ ─ ─ → system channel 已注册，直接处理
                                                                  ← ─ 返回结果 ──────────────────→
```

## 修复方案

给 `ChannelServer` 加 `deferInit` 选项：

- **Local 模式**：构造时立即发 `Initialize`（行为不变）
- **Remote 模式**：构造时不发 `Initialize`，等 `registerChannel` 全部完成后调 `server.ready()` 手动发送

涉及文件：
- `packages/rpc/src/channels.ts` — `ChannelServer` 构造函数加 `deferInit` 参数，新增 `ready()` 方法
- `packages/rpc/src/logging-middleware.ts` — `LoggingChannelServer` 透传 `ready()`
- `packages/desktop/src/host/index.ts` — remote 模式传 `deferInit=true`，服务注册后调 `server.ready()`

## pending 请求的终态语义（超时 / 取消 / dispose）

`pendingRequests` 只暂存"channel 尚未注册"的请求，不改变请求自身的生命周期边界。终态规则：

- **超时即终态**：超时定时器先把条目移出所在队列，再按请求类型回终态帧：`Promise` 回 `PromiseError`；`EventListen` 回 `EventError`（终结该次订阅周期，客户端释放监听器后可重新订阅；旧客户端忽略未知 `205` 响应）。此后即使 `registerChannel` 到来，也不得再执行该请求或建立该订阅。
- **取消即终态**：`PromiseCancel` / `EventDispose` 同时作用于 `activeRequests` 与 `pendingRequests`（按请求 id 移除并停掉定时器）。客户端已取消的请求，迟到的 `registerChannel` 不得执行，也不再补发超时错误。
- **dispose 即终态**：`dispose()` 清空全部 pending 定时器与队列；`registerChannel` 的延迟 flush 与超时回包在 dispose 后不再执行、不再发送。
- 保留语义：请求在超时窗口内等到 channel 注册，则恰好执行一次。

事件顺序（owner：`ChannelServer` 独占 pending 队列与其定时器）：

```text
client                    ChannelServer                channel
  │ Promise(id) ─────────► │                             │
  │                        │ channel 未注册 → 入队+定时器 │
  │ PromiseCancel(id) ───► │ 按 id 移除 pending+定时器    │
  │                        │                             │
  │                        │ registerChannel ◄───────────┤ 迟到
  │                        │ flush 只执行仍在队列的请求    │
  │           （已取消的 id 不执行、不再回包）             │
```
