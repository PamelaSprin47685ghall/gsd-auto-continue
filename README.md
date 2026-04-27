# GSD Auto Continue

`gsd-auto-continue` 是一款极简、优雅的 GSD (Get Shit Done) 插件。它的主要职责是在 `auto-mode` 下发生意外的中断、错误或上下文溢出时，接管执行权并尝试进行自恢复。它使代理程序能够在遭遇短暂的网络错误或逻辑阻滞时“带病继续工作”，显著减少了人为手动干预的次数。

相较于早期充满复杂状态机和内部 API 劫持的设计，本插件通过官方 `Extension API` 和事件系统进行了彻底的极简重构。零依赖，单文件，仅用 200 余行原生 JavaScript 实现了全链路保护。

## 特性

- **附加上下文恢复 (With-Context Continuation)**
  - 在执行回合中，拦截由于验证失败或工具调用错误引发的 `stop`。
  - 通过重试消息进行错误修正，附带最高 **5 次的指数退避**，以防范网络抖动和服务器抽风。
- **无上下文自动恢复 (Without-Context Recovery)**
  - 拦截当代理出现严重的上下文满载（`context_overflow`）或被强制阻塞（`blocked`）后的中断。
  - 开启一个隐式会话，让 LLM 主动对失败现场进行独立诊断。诊断完毕后，自动向 GSD 内核发射 `/gsd auto` 以满血复活 `auto-mode`。
- **工具死循环防护 (Tool Call Loop Guards)**
  - 精准监控连续发起**相同输入**的无效工具调用。如果连续 4 次徒劳无功，本插件会向 LLM 投喂一段虚假的 “成功” 输出，用大写文字强制要求它 “重新思考方案”，从根源切断系统级崩溃。
- **语义校验拦截补丁 (Semantic Validation Patch)**
  - 由于 GSD 核心存在严格的结构体验证（且错三次即直接崩溃退出），此功能劫持了核心的参数校验层。
  - **自动抹平**：对于大模型错误输出的 JSON 字符串进行透明反序列化。
  - **强硬阻断**：对于缺失必要字段的调用（例如发布 `plan_milestone` 完整切片却忘记填写 `integrationClosure`），直接短路返回假结果并塞入 `[SEMANTIC VALIDATION ERROR]` 给模型自我反思，而不是抛给底层使其闪退。

## 安装

这是为 `pi-coding-agent` (GSD) 开发的非官方社区插件。假设你当前位于 GSD 配置的插件目录中：

```bash
git clone https://github.com/your-username/gsd-auto-continue.git
```

在插件目录内确保 `package.json` 包含 GSD 和 Pi 所需的配置项：

```json
{
  "gsd": {
    "extension": true
  },
  "pi": {
    "extensions": ["index.js"]
  }
}
```

启用即可在执行 `/gsd auto` 时享受自愈保护。

## 架构：为什么“极简”更好

在此插件的设计演进中，我们经历了极其严重的“过度设计”阶段：早期的代码通过劫持核心内部 API（如 `Agent.prototype.prompt`），依赖了超量 Typescript 类型与类。由于其过重的架构，一点小的升级就会导致崩溃。

新版 `index.js` 仅仅通过这几个核心事件便优雅地实现了复杂的恢复流：
- `unit_start` / `unit_end`：安全地获取引擎当前的激活状态。
- `stop`：唯一的状态跃迁点，判断重试逻辑。
- `before_agent_start`：仅仅在回合启动前，借过一下 `pi.tools` 的指针，对特定工具施加一层简单的 JavaScript 闭包 Proxy，轻快而安全地完成验证拦截。

所有一切都被局限在这个单文件、轻量级的事件处理器中。

## 运行测试

只需安装 Node.js (>=20) ，即可运行零外部依赖的内建测试：

```bash
node --test index.test.mjs
```

```text
▶ gsd-auto-continue
  ✔ registers all required events (0.42ms)
  ✔ handles stop event with reason error (With-Context Continuation) (1101.51ms)
  ✔ handles stop event with reason blocked (Without-Context Recovery) (0.88ms)
  ✔ patches gsd_ tools and catches validation errors (1.47ms)
  ✔ decodes JSON strings for schema array fields before validation (0.90ms)
  ✔ validates conditional requirements (integrationClosure) for full slices (0.72ms)
```

## 证书

MIT License
