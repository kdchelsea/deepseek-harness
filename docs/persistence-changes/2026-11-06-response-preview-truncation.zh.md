---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-06-response-preview-truncation

[English](2026-11-06-response-preview-truncation.md) | 中文

## 概述

为持久化的轨迹响应元数据增加可选截断标记。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-06-response-preview-truncation
baseline: false
changes:
  - root: "event:trajectory/response"
    previous: "2026-10-28-trajectory-provider-bodies"
    after: "e52de9dd97436f3de9ba0d43d2c86f7379644e3a88c5e40e0b672b1cb2b86f40"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

truncated 为可选字段，因此已有 trajectory/response 记录仍有效。新读取方保留字段缺失状态，只在其为 true 时显示警告。complete 仍表示传输 EOF，即使保存的预览被截断。旧读取方可能忽略新增显示注释；轨迹响应数据不进入模型历史，也不驱动工具执行。不重写任何历史代际，Session 写入版本保持不变。

<a id="verification"></a>
## 验证

响应捕获、适配器／配置及轨迹 Host／Client 定向测试共 250 项通过，覆盖字节上限、complete 与 truncated 独立、缺少字段的旧记录、可选字段传输校验和独立 UI 提示。源码与构建版 headless 进程验证各通过 8 个场景，包括 SIGKILL 后保留响应前缀。

<a id="dev-note"></a>
## 开发备注

无。
