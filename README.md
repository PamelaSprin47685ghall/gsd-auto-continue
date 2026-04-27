# gsd-auto-continue

Auto-mode 断点续跑扩展。事件驱动，零依赖，单文件。

## 功能

- **Pause Detection** — 检测 auto-mode 暂停/停滞，自动重发 `/gsd auto`（上限 5 次）
- **Error Retry** — `stop("error")` 后指数退避重试（1s → 2s → 4s → 8s → 10s，上限 5 次），携带错误上下文
- **Loop Guard** — 阻断 4 次及以上相同的工具+参数重复调用
- **Arg Validation** — 执行阶段拦截 `bash`/`write` 等关键工具的无效参数

## 事件

| 事件 | 来源 | 用途 |
|---|---|---|
| `stop` | agent-session.ts | 节奏检测 + 错误重试 |
| `tool_call` | agent-session.ts | 循环阻断 + GSD 标记 |
| `before_agent_start` | agent-session.ts | 心跳清除 |
| `input` | agent-session.ts | 用户操作检测 |

## 安装

项目 `package.json` 中添加：

```json
{
  "pi": { "extensions": ["index.js"] }
}
```

## 测试

```bash
npm test
```

## 许可

MIT
