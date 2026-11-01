# 提案：commandId 复用冲突检测（idempotency intent conflict）

状态：**提案，未实现**。等待维护者评审（zai-org/feedback#1341）。本文件只定义目标语义与
开放问题；实现前须先在 `10-protocol-spec.md` 落定正式条款。

## 背景与现状

`CommandInbox` 以 `{sessionId, commandId}` 为幂等键（`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/command-inbox.ts`）。
命中既有收据时直接回放（`duplicate`，保留原 result），不比较本次提交与首次提交是否描述同一操作。

实测（依赖真实 inbox 源码的有界探针）：同一 `{sessionId, commandId}` 先提交 `sendText` 并结算，
再提交 `stop`，第二次收到的是 `duplicate` 而非冲突。第二个操作不会执行（不是越权执行），但
客户端可能把 `duplicate` 误读为"我请求的操作已成功"，而收据实际属于另一个操作。

## 目标

1. 精确重试（同 intent）仍返回原收据，不重放副作用。
2. 同键不同 intent 的提交得到明确的冲突信号，而不是模糊的 `duplicate`。
3. 不破坏现有恢复路径：不把 `clientId` 简单并入幂等键（会改变重试归属与既有 LRU/持久收据的
   命中语义），不引入自动重发。

## 提案

### 1. 不可变 intent 字段与指纹

在命令 admission 边界（CLI 侧 `CommandInbox`，即收到信封之后、执行之前）对**调用方 intent** 计算
规范化指纹并随收据持久化：

- 参与指纹：`type` + payload 中的调用方语义字段（规范排序、显式缺省）。
- 排除指纹：Host/链路注入的非 intent 字段，如 `inputOrigin`、`browserAmbientContext`、
  `ttft`、`issuedAt`、Host 为 `createSession` 预留的 `sessionId` 回填、automation denylist 合并等
  富集字段；以及一切易变遥测。指纹必须在"同一逻辑命令的自然重试"下稳定。
- 规范化规则需成文：对象键排序、可选字段缺省与显式默认的等价性、数组保序。

### 2. 冲突判定

命中既有收据时：

- 收据带指纹且与本次一致 → 维持现状 `duplicate`（回放 result）。
- 收据带指纹且不一致 → 返回冲突。建议 wire 兼容形态：`status: rejected` +
  `reasonCode: proto.idempotencyConflict`（六态枚举不变，旧客户端按 guard 错误码分流；
  是否需要独立 status 留作评审决定）。
- 收据无指纹（存量持久事实：transcript/timeline/child/discarded 回源）→ **不得**默认等同。
  存量期内回 `duplicate`（保持现行为）或按配置回冲突，需维护者定夺并在 spec 标注过渡期。

### 3. 事件顺序（owner：CommandInbox）

```text
client                    CommandInbox              持久收据/LRU
  │ command(id,intent) ──► │                          │
  │                        │ 查键 {sessionId,id} ────► │
  │                        │ ◄── 收据(指纹?)           │
  │                        │ 有指纹: 比对 intent        │
  │                        │   一致 → duplicate(回放)  │
  │                        │   不一致 → rejected       │
  │                        │      (idempotencyConflict)│
  │                        │ 无指纹 → 按过渡策略        │
  │                        │ 未命中 → admission+落指纹 │
```

## 验收场景（实现时转为回归）

1. 精确重试：同 intent 重试返回原 result，零次重复执行。
2. 冲突：同键换 `type`（sendText→stop）与换语义 payload 各返回冲突，不执行第二操作。
3. 稳定性：Host 富集字段变化（inputOrigin/browserAmbientContext 等）不产生假冲突。
4. 规范化：键序不同、可省字段缺省 vs 默认的重试不产生假冲突。
5. 存量：无指纹持久收据按过渡策略行为一致（两种策略都要有测试）。
6. 重启：内存 LRU 淘汰后经持久回源仍能正确分流。

## 开放问题（需维护者决定）

- 冲突信号走 `rejected + reasonCode` 还是新增 ACK status（wire 兼容性权衡）。
- 存量无指纹收据的过渡策略与期限。
- `createSession` 的 payload 在首构造时会回填 `sessionId`，指纹应基于回填前还是回填后的
  规范形态（建议：回填后，且该回填字段列入"富集"而非调用方 intent）。
- 指纹算法与长度（建议 SHA-256 截断，非安全用途，只求稳定与碰撞概率可忽略）。
