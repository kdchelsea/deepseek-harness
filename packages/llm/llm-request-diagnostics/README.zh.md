---
description: "通过有界的请求元数据和原始响应体前缀检查尚未完成的模型调用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-request-diagnostics

[English](README.md) | 中文

## 概述

在响应流结束前检查尚未完成的模型请求。每个请求都有私有 NDJSON 元数据文件和独立的原始响应体文件，消费者读取时即可查看。响应体可能包含敏感文本，包括回显的提示词或凭据。记录采用有界同步写入；观测失败写入标准错误，不使模型调用失败。文件独立于 Session 历史与模型上下文。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

基于 base 的 profile 通过 `llm-request-diagnostics` 条目启用此插件，写入 Harness 主目录下的 `logs/llm-requests`。独立组合可以通过插件条目配置：

```yaml
- name: '@deepseek-ai/dsh-llm-request-diagnostics'
  config:
    directory: /absolute/path/to/request-diagnostics
    progressIntervalMs: 5000
    maxFileBytes: 1048576
    maxResponseBodyBytes: 16777216
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `directory` | 必填 | 存放 UUID 命名的元数据文件和响应体文件的父目录 |
| `progressIntervalMs` | `5000` | 周期进度快照的正整数毫秒间隔 |
| `maxFileBytes` | `1048576` | 元数据字节上限，至少 8192；为 body-end、截断、取消和终态记录预留空间 |
| `maxResponseBodyBytes` | `16777216` | 一次适配器调用内所有 HTTP 回复的原始响应体总字节数；`0` 禁用响应体文件 |

每条记录包含 `schemaVersion: 1`、请求 UUID 和 Unix 时间戳毫秒值 `timeMs`。`request-start` 额外记录起始时间、可选 Session id 与 purpose、provider 和 model；每个标识最多保留 128 个 UTF-16 代码单元。HTTP 交换使用请求内的数字 id。HTTP 派发、响应头、首次消费响应体字节、响应体 EOF／错误／取消、首个归一化分片、signal 取消以及 finish 都同步写入。`lastNormalizedChunkType` 只记录分片类型。`model-finish` 事件在迭代器清理前立即记录 provider 的结束类型和过滤后的错误码，之后的 `finish` 再记录请求最终结果。后续字节和非终态分片只更新计数，不逐 token 写文件；周期进度和终态记录携带最新总量及首次／末次时间戳。

`consumedBodyBytes` 统计消费者通过包装后的 fetch 响应读取的解码后响应体字节，不测量线上字节，也不证明数据到达网络 socket 的时间。`httpObserved: false` 表示未观察到包装后的 fetch，而非 provider 没有发送请求。消费者停滞时，传输缓冲区可能已有数据，但字节计数仍不变。

每个 HTTP 回复在 `<requestId>.ndjson` 旁生成 `<requestId>.<httpId>.response.bin`。已消费的原始 `Uint8Array` 分片在交付前写入，不进行文本解码、tee、预读或完整响应体缓冲。整次调用共用的预算按消费顺序保留各回复的前缀；重试不会重置预算。`body-open` 引用文件并记录最多 128 个 UTF-16 代码单元的 `contentType`。`body-end` 记录已消费和已写入的字节数、截断、捕获或流错误，以及流是否不完整。EOF 只表示 HTTP 响应体结束，与推理完成相互独立。tracker 完成或被释放时关闭未结束的文件，标记 `reason: unfinished`；之后仍可消费响应，但不再捕获。进程被强制终止时保留已写入的前缀，不补写结束记录。

元数据不包含 URL、查询参数、请求 headers、提示词、工具定义或参数、归一化响应文本、错误消息和取消原因；受长度限制的响应内容类型是唯一记录的 header 值。原始响应文件不做脱敏，可能包含 provider 返回的任何敏感数据。finish 错误码必须匹配 `[A-Z][A-Z0-9_]{0,63}`；其他传入错误码统一记录为 `UNCLASSIFIED`。文件以 0600 模式独占创建，新目录请求 0700 模式；已有目录的权限保持不变，Windows 访问遵循其 ACL。交付前写入已交给操作系统，不提供 fsync 或断电持久性保证。

达到元数据上限时，单条 `log-truncated` 事件标记后续中间记录被抑制，已接纳响应体的文件引用和结束记录、model-finish、取消和 finish 仍可记录。新响应体文件需要为引用和结束记录预留元数据空间；空间不足时跳过捕获，并通过 `bodyCaptureSkipped` 报告数量。`observer-disposed` 表示模型结束前插件已卸载，不代表模型结果。已打开但没有结束记录的响应体是不完整记录。响应体文件失败输出固定的标准错误诊断并保留已保存的前缀；元数据文件失败则禁用 tracker。两类失败都不改变模型执行。重复的 observer provider 会被报告，本插件保留下游 observer，不创建第二份文件。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

同步的 `llm/request-diagnostics` waterfall 为每次适配器调用分配一个 tracker。UUID 关联元数据和响应体文件，不猜测 agent（智能体）的步骤编号。插件通过 Cordis 生命周期管理自己的活动集合、文件描述符、定时器清理和取消监听器清理。包装后的响应体只在消费者请求时拉取一个原始分片，不 tee，也不预读。响应元数据和标准响应体读取方法保持可用。卸载插件会关闭文件并停止定时器，不取消模型请求。

| 文件 | 职责 |
|---|---|
| [src/index.ts](src/index.ts) | 配置、waterfall 注册和插件生命周期 |
| [src/tracker.ts](src/tracker.ts) | 文件上限、同步记录、计数器与按需 fetch 观测 |

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [LLM 服务](../llm/README.zh.md)——逐调用 observer 接口与适配器派发。
- [LLM 重试](../llm-retry/README.zh.md)——请求恢复策略与重试事件。
- [Base bundle](../../bundle/base/README.zh.md)——默认 profile 组合。

-----

<a id="model-experience"></a>
## 模型体验

无，记录独立于 Session 历史，不添加模型可见的提示词、工具或消息。

#### KV Cache 影响

无，诊断元数据不进入模型请求。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

以下限制影响诊断与日志保留：

- HTTP 阶段要求适配器使用 observer 的 fetch。其他传输可能只提供归一化分片观测；缺失 HTTP 观测不能证明网络停滞。
- 元数据和响应体字节预算按调用限制；跨调用的文件数量与保留周期不自动管理。运维人员负责可能含敏感信息的捕获文件的访问控制、归档和删除。
- 慢速文件系统上的同步写入可能延迟请求。主机崩溃可能留下不完整的末行，只应读取完整的 NDJSON 记录。
- 消费者读取时间无法区分上游暂停和消费者尚未请求的已缓冲数据；需要网关日志或传输层观测才能区分。

<a id="dev-note"></a>
### 开发备注

无。
