# 使用 Harbor 评测 DSH

[English](README.md) | 中文

## 概述

在一次性 Docker 任务环境中运行 DSH 完整的 headless agent（智能体），再由 Harbor 的独立验收器对生成的文件或环境状态评分。此接入固定使用 Harbor 0.25.0，支持本地任务和指定版本的 Terminal-Bench 数据集，不替换 DSH 的模型循环或工具。

## 目录

- [安装](#install)
- [检查接入链路](#check-the-integration)
- [运行基准评测](#run-a-benchmark)
- [读取结果](#read-results)
- [配置与限制](#configuration-and-limits)
- [维护适配器](#maintain-the-adapter)

<a id="install"></a>

## 安装

需要 Python 3.12 或更新版本、uv，以及已启动的 Docker Engine 或 Docker Desktop。以下命令均从仓库根目录运行。将 Python 环境放在源码目录之外：

```sh
export UV_PROJECT_ENVIRONMENT="$PWD/.cache/dsh-harbor-venv"
uv sync --locked --project python/harbor-eval --group test
uv run --project python/harbor-eval dsh-eval doctor
```

任务镜像必须提供 bash、apt-get、安装阶段的 root 权限，以及 Python 3.10 或更新版本和 glibc 2.28 或更新版本的发行版。生成的冒烟任务使用 Debian Bookworm。安装需要访问系统软件仓库和 PyPI，执行模型还需要访问对应的服务端点。

<a id="check-the-integration"></a>

## 检查接入链路

生成一个新的本地任务。脚本模拟的模型会指示真实 DSH 运行时调用工具，读取数字并写入它们的和。验收器独立检查文件。这只检查接入链路，不衡量模型智能：

```sh
uv run --project python/harbor-eval dsh-eval smoke-task .artifacts/dsh-eval/smoke --keyless
DEEPSEEK_API_KEY=dsh-keyless-smoke uv run --project python/harbor-eval dsh-eval run \
  --path .artifacts/dsh-eval/smoke \
  --runtime-version 0.2.1rc2 \
  --model deepseek-official/deepseek-v4-flash \
  --base-url http://127.0.0.1:8765/anthropic \
  --name smoke-dsh
uv run --project python/harbor-eval dsh-eval report .artifacts/dsh-eval/smoke-dsh
```

上面的凭据是仅供任务内部 mock 端点使用的占位值。预期奖励为 1。同时验证验收器的正例和负例：

```sh
uv run --project python/harbor-eval harbor run -p .artifacts/dsh-eval/smoke -a oracle -e docker -n 1 -k 1 -r 0 -o .artifacts/dsh-eval --job-name smoke-oracle
uv run --project python/harbor-eval harbor run -p .artifacts/dsh-eval/smoke -a nop -e docker -n 1 -k 1 -r 0 -o .artifacts/dsh-eval --job-name smoke-nop
```

Oracle 必须得到 1，nop 必须得到 0。Harbor 进程退出码为零不能证明任务通过，需要检查异常和验收奖励。已有的任务目录和 DSH 作业名会被拒绝；重跑时请使用新名字，保留已有验证记录。

<a id="run-a-benchmark"></a>

## 运行基准评测

在启动终端中导出真实的 `DEEPSEEK_API_KEY`。包装命令只检查它是否存在，不显示值，并向 Harbor 传入环境变量引用。先选一个任务运行一次，检查失败原因后再增加重复次数和并发数。下面的命令仅预览调用，不分配容器或调用模型：

```sh
uv run --project python/harbor-eval dsh-eval run \
  --dataset terminal-bench@2.0 \
  --runtime-version 0.2.1rc2 \
  --model deepseek-official/deepseek-v4-flash \
  --name terminal-bench-baseline \
  --attempts 3 --concurrency 1 \
  --dry-run
```

去掉 `--dry-run` 即可执行。数据集可用性、模型权限和真实模型质量都需要实际评测验证；无密钥集成检查不能证明 Terminal-Bench 成绩。使用可重复的 `--task NAME` 参数筛选少量初始任务。报告必须保留数据集版本、任务选择、重复次数、模型、推理强度和 DSH 配置。

`--runtime-version` 评测的是指定发布版，不是当前工作区。要评测本地 DSH 修改，请按照 [Python 构建说明](../development.zh.md) 在匹配的 Linux 架构上构建运行时 wheel，再将版本参数替换为 `--runtime-wheel /absolute/path/to/the-linux-runtime.whl`。适配器会上传 wheel 并记录 SHA-256。宿主 macOS wheel 无法在 Linux 任务容器中运行。

<a id="read-results"></a>

## 读取结果

每个作业目录包含 Harbor 汇总结果和各次任务结果。`dsh-eval report JOB_DIRECTORY` 命令输出 JSON，包含通过数、验收失败数、执行错误数、agent 执行耗时及各次结果。它支持 `reward` 为 0 或 1 的单步任务，遵守 Harbor 的奖励有效性规则，并将错误保留在已结束任务的分母中。它不包含尚未结束的任务；发布成绩前应确认 Harbor 作业已经结束。Harbor 可能接受 agent 超时后的验收奖励，此时行中仍显示异常。

每次任务的 `agent/` 目录保留 `dsh.jsonl`、`dsh.stderr.log`、`dsh-manifest.json`、生效的模型路由覆盖配置、原始任务及独立的 `dsh-home/`。`stream_completed` 只描述 JSON 事件流的终态，进程失败和验收奖励是独立事实。日志缺失或格式损坏会产生明确的元数据诊断。token 和费用字段保持未知，因为 headless JSON 投影不包含完整用量，包括委派给子 agent 的用量。

比较 harness 版本时，应固定模型、推理强度、任务版本、环境和执行预算。重复三次用于衡量波动，此报告的通过比例不是 pass@3。不要将生成的冒烟任务奖励标为能力基准成绩。

<a id="configuration-and-limits"></a>

## 配置与限制

`dsh-eval run --help` 列出包装命令的参数。Harbor agent 导入路径是 `dsh_harbor.agent:DshAgent`；直接使用 Harbor 时，可以通过 `--ak` 传入 `runtime_version` 或 `runtime_wheel`、`patch`、`reasoning_effort` 和 `permission_mode`。

- 模型名采用 DSH 的 `provider/model` 格式。Harbor 的 LiteLLM 对未知 DSH provider 给出的警告不会改变路由，DSH 会收到显式配置。
- `--patch` 提供独立完整的 Cordis 覆盖配置，用于额外的 provider 设置。生成的模型路由和审批策略最后应用。不要在覆盖配置中写入明文凭据，复制的配置和会话日志会作为产物保留。
- `--key-env` 选择凭据环境变量名；`--base-url` 设置 `DEEPSEEK_BASE_URL`。其他 provider 需要对应的 DSH 覆盖配置，包装命令不会把任意 provider 转换为 DeepSeek 配置。
- 适配器保留任务的工作目录和执行用户，安装以容器 root 身份运行。DSH 在一次性容器内使用 `danger-full-access` 和 `approval=never`，此适配器不挂载宿主工作区和用户 DSH 主目录。直接使用 Harbor 时，可以选择 `permission_mode=workspace-write` 来评测该权限策略。
- Harbor 负责任务超时、容器销毁和验收器执行。包装命令关闭编排层重试，避免失败的尝试被静默替换。安装失败会停止执行，Harbor 能取回的部分日志会被保留。
- 尚未实现恢复运行、ATIF 轨迹转换、GUI 评测和完整的 token／费用统计。提供的检查覆盖已安装发布版路径，本地构建的 wheel 需要单独运行冒烟测试。

<a id="maintain-the-adapter"></a>

## 维护适配器

修改适配器后运行针对性检查：

```sh
uv run --project python/harbor-eval python -m pytest python/harbor-eval/tests -q
```

测试覆盖损坏或缺失日志、日志看似完成但进程失败、任务文本原样传递、凭据引用、私有上传文件属主、任务生成，以及基于 Harbor 持久化 schema 的报告分类。修改执行逻辑后，应重跑容器冒烟测试及 oracle／nop 对照。执行接口参见 [Harbor](https://github.com/harbor-framework/harbor/tree/v0.25.0) 和 [DSH headless](../../packages/bundle/headless/README.zh.md)。
