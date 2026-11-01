# 提案：多窗口远程控制的所有权与交接（multi-window ownership）

状态：**提案，未实现**。等待维护者评审与产品决策（zai-org/feedback#1342）。生产 relay 后端
不在本仓库内，后端实际行为需服务端确认后再实现。

## 背景与现状

桌面端按窗口维护 `WindowControlRuntime`（`packages/desktop/src/main/webRemoteControlManager.ts`），
但同一账号/endpoint 复用**一个持久化 device SID**（`webRemoteControlDeviceStorage.ts` 只存一份
注册），每个窗口启动各自独立的 device transport。relay 侧文档（`relay-v2-pairing.md`）定义
`(SID, role)` 只有唯一 current owner，新 owner 顶替旧 owner 并对其发 `KICKED`。

两者组合的含义：两个窗口同时开启远程控制时，共用同一 QR/SID 目标；若生产 relay 按文档执行
替换，窗口 B 上线会把 A 顶下线，A 的自动重连又可能把 B 顶下线，形成所有权拉锯。手机端看到
的窗口/工作区目录可能随最后一次替换静默漂移。

## 目标

1. 任意时刻每条 device link 的受控窗口**确定且可解释**，不发生静默漂移。
2. 多窗口用户得到明确的所有权状态与显式交接，而不是连接替换竞赛。
3. 不改变"手机复用窗口已有 Host attachment"的边界：不新建 Agent/Local Host/远程会话，
   relay 与 Main 仍只做鉴权、配对、心跳、转发与 attachment 调度。

## 候选方案

### 方案 A（推荐，改动最小）：一个 SID 同一时刻只允许一个窗口开启

- 第二个窗口尝试开启时，桌面明确提示"远程控制已由窗口 X 占用"，提供**显式交接**按钮；
  交接 = 旧窗口主动停用（断开 device transport 并清理 runtime）→ 新窗口再上线，不经过
  relay 的 KICKED 替换路径。
- 旧窗口 UI 显示"已移交"；关闭属主窗口产生明确的 offline/handoff 状态，由用户决定去向。

### 方案 B（较大改动）：每窗口独立 SID，按 MID 分组

- 每个窗口注册自己的 device SID（同一物理 MID 分组），手机设备列表按窗口展示多条可控
  目标。支持多窗口同时受控，但涉及 relay 设备模型、注册/删除 API、手机列表 UI 与通知
  归属的产品面变化，需产品与后端共同评审。

## 事件顺序（方案 A；owner：Main 的 webRemoteControlManager 持有每账号唯一 enable 属主）

```text
窗口A(enable)          Main manager              relay           手机
  │ register/transport │                          │               │
  │ ◄────────────────► │ owner=A                  │ owner=(SID,A) │ paired→A
  │                    │                          │               │
  │        窗口B 请求 enable ────────────────────► │               │
  │ ◄── 提示占用/交接选项                           │               │
  │ (用户选交接) A 主动停用 ─────────────────────► │ owner 撤销    │ offline
  │                    │ owner=B; B 上线 ────────► │ owner=(SID,B) │ paired→B
  │                    │                          │               │ （无 KICKED 拉锯）
```

## 验收场景（实现时转为回归）

1. 窗口 A enabled 后窗口 B 请求 enable：B 得到占用提示，A 不被顶下线。
2. 显式交接后：A 显示已移交且 transport 关闭，B 成为唯一 owner，手机不再连到 A。
3. 关闭属主窗口：手机收到明确的 offline/handoff 状态，非静默漂移。
4. 属主窗口重连不得在无用户动作下夺回所有权。
5. 单窗口行为与现状完全一致（回归基线）。

## 开放问题（需维护者决定）

- 方案 A / B 的产品取舍；方案 B 需要 relay 设备模型与手机 UI 的配套变更。
- 生产 relay 对 `(SID, role)` 替换、`KICKED` 与重连的真实行为确认（客户端只有文档与
  fake relay 证据）。
- 交接是否需要在手机端弹确认，或纯桌面侧操作即可。
- 与 `webRemoteControlManager` 现有 per-window 停用路径（`stop(windowId)` →
  `stopWindowRuntime(windowId, reason)`，只停请求窗口）的整合方式。
