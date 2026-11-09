---
kind: upgrade-guide
description: "响应检查保留有界前缀，base profile 在请求完成前保存私有原始响应诊断。"
---

# 响应捕获上限与诊断文件

[English](guide.md) | 中文

## 变更

Web 轨迹检查使用的原始响应预览默认每次模型生成共用 16 MiB 字节预算，覆盖其全部 HTTP 响应。更大的响应仍完整交付给模型适配器，但预览会截断并明确标记。`complete` 仍表示传输 EOF；可选字段 `truncated` 独立表示预览省略。

base profile 也会在请求诊断目录中增量保存已消费的响应前缀，包括 headless 运行。这些私有文件可能包含敏感生成内容。默认 16 MiB 预算与 Web 预览预算独立。关闭正文留存后仍保留进展元数据。

## 迁移

1. 检查诊断目录的访问权限与保留策略。禁止留存响应内容时，将 `llm-request-diagnostics.maxResponseBodyBytes` 设为 `0`，或选择合适的单次调用预算。[诊断配置](../../../../packages/llm/llm-request-diagnostics/README.zh.md)定义目录、上限和不完整文件处理方式。
2. 需要更大 Web 预览的消费者可在 DeepSeek 提供方配置，或 `llm-pi-ai.providers.<provider>` 下设置 `responseCaptureMaxBytes`。零关闭该预览，此设置不会关闭独立的磁盘诊断；配置细节分别见 [pi-ai](../../../../packages/llm/llm-pi-ai/README.zh.md) 与 [DeepSeek](../../../../packages/llm/llm-deepseek/README.zh.md)。
3. 把保存的前缀视为完整内容前，先检查响应元数据。Web 中分别查看截断与读取未完成提示。诊断文件在进程终止后缺少 body-end 记录，表示未完成的证据，不代表响应或工具执行成功。
