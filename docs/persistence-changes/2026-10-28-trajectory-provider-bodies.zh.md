---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-28-trajectory-provider-bodies

[English](2026-10-28-trajectory-provider-bodies.md) | 中文

## 概述

为轨迹检查器记录提供方请求与响应的附件引用。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-28-trajectory-provider-bodies
baseline: false
changes:
  - root: "event:trajectory/request"
    previous: null
    after: "cb54846a57eace88b7a9d14b3a6eec16f4bcbf3ff3ecaeac4417126c1b08313a"
    decision: same-version
  - root: "event:trajectory/response"
    previous: null
    after: "73e821b64bb19088ea5edca918508606c8ed541d11a7b50b4387c7e3d6ee227d"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

新增仅写日志的 trajectory/request 和 trajectory/response 事件类型，不改变已有载荷或模型历史。新读取器继续接受已有发布版本的会话。旧读取器会在重建或修改会话前拒绝这些未知必需事件，不会静默遗漏模型可见数据。历史代际文件保持不变。

<a id="verification"></a>
## 验证

定向 Vitest 运行已通过轨迹采集与读取测试、响应采集测试，以及使用本地 HTTP 夹具的两个提供方适配器测试。

<a id="dev-note"></a>
## 开发备注

无。
