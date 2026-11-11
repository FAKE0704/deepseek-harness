# DeepSeek Harness 容器执行 Provider 家族 — 设计文档

> **状态**：草稿 v0.1（AI 辅助快速生成 — 见[署名说明](#署名说明)）
> **作者**：FAKE0704
> **讨论帖**：[deepseek-ai/deepseek-harness#9120](https://github.com/deepseek-ai/deepseek-harness/discussions/9120)
> **目标版本**：DSH 0.2.2-rc.1（撰写时的上游 `master`；全部引用于 2026-11-11 抓取核验）

## 署名说明

本文档由 FAKE0704 主导、AI（DeepSeek Harness）辅助快速生成。所有关于上游源码的主张均以 `path:line` 形式标注，对应 `deepseek-ai/deepseek-harness@master`，撰写时经机器核验。设计决策、取舍及判断层面的错误归作者；事实性错误请在讨论帖中指出，我们会更正。本文档与讨论帖 #9120 在源码事实上有出入时，以本文档为准。

## 摘要

一套**分阶段交付的容器执行 provider 家族**，以 in-repo 的 `dsh-ssh` 家族为模板，遵循 `packages/sandbox/sandbox/src/index.ts` 为容器预留的 seam 替换架构。

- **Stage A**（以周计）：原封不动的 `dsh-ssh` 家族连到一个跑 sshd 的容器；容器由一个小型本地生命周期插件创建、锁定、销毁。立即交付真实隔离价值，上游零改动。
- **Stage B**：原生 Docker 家族，传输层换为 `docker exec` stdio——同一个 helper、同一套线协议，无 sshd、无 SSH 配置管理，且真正支持 `--network none`。
- **策略归上游所有**：`danger-full-access` 默认在容器内拒绝——刻意比今天 ssh 世界的实际行为（该档位在目标世界内裸跑）**更严格**（§6.1）。opt-in 恢复上游语义；逐调用 `SandboxExecutionPolicy` 语义——含 `approveEscalation` 审批升级阶梯——由容器内 helper 原样执行。
- **为收编而设计**：包结构、命名、测试约定全部对齐 `dsh-ssh` 家族，上游日后收编任何部分都是"搬移"而非"重写"。

## 1. 目标与非目标

**目标**

1. 为 DSH 执行世界提供内核级边界隔离，以**整套 seam 替换**交付（`packages/sandbox/sandbox/src/index.ts:2-4` 为容器预留的位），而不是注册为 `ctx.sandbox` 后端。
2. 逐调用策略语义**原样保留**：`SandboxExecutionPolicy` 随每次调用传递；`approveEscalation` 阶梯留在宿主侧；执行发生在执行侧主机。
3. 分阶段：Stage A（原版 `dsh-ssh` + 生命周期插件，上游零改动）→ Stage B（原生 `docker exec` 传输）。
4. 收编友好的结构：约定对齐 `dsh-ssh` 家族，收编即搬移。
5. 镜像级供应链锁定：镜像 digest + helper 工件 digest 双锁定并对外可见。

**非目标**

1. 不改任何 seam 接口、策略词表或升级阶梯。
2. 不引入网络/进程可见性策略轴（§8）——仅容器 `Config`。
3. 不做 `shell-docker` 包：shell 家族组合在 `subprocess`/`sandbox` seam 之上，自动随行（§3.3）。
4. 不在本设计中做云后端（Modal/Daytona）；传输 seam 保持无关，便于日后跟进（§5.4）。
5. 不防御恶意执行主机：digest 锁定校验的是工件而非主机意图——ssh 家族明示此限，我们继承（`packages/ssh/ssh/README.md` 信任模型说明；`sandbox-ssh/README.md:67-68` 受信基础设施边界）。

## 2. 背景：seam 替换架构

DSH 的 sandbox 服务在文档中明确是**同世界**（same-world）约束 seam。`packages/sandbox/sandbox/src/index.ts:1-4`（逐字核验）：

> Service Definition for the same-world process-confinement capability seam: wrap exact subprocess argv under a host-path file policy. **Containers, microVMs, and remote execution replace the surrounding capability seam instead**; this service shares the host kernel and filesystem.

由当前代码树可得三个事实（均对 `master` 核验，DSH `0.2.2-rc.1`）：

1. **先例已存在。** `@deepseek-ai/dsh-ssh` 家族（`packages/ssh/{ssh,fs-ssh,subprocess-ssh,sandbox-ssh,ssh-helper-runtime}`）已为远程世界替换 fs、subprocess、sandbox 三个 seam；家族 README 写明它 "implements the existing filesystem, subprocess and sandbox APIs; it introduces no SSH-specific model tools"（`docs/subsystems/ssh.md:5`），且容器与远程执行器 "replace whole capabilities instead of registering here"（`packages/sandbox/README.md:12`）。
2. **容器位是空的。** 撰写时 `packages/` 下没有任何 Docker/容器/microVM 家族。上游甚至在 `packages/sandbox/sandbox-local/README.md:148-150` 记录了未决问题：*"An environment-coherent capability group example, such as bash plus fs against one container"*。本家族正是这个问题的答案。
3. **生态压力真实存在。** Hermes Agent（[NousResearch/Hermes-Agent](https://github.com/NousResearch/Hermes-Agent)）提供 first-party 终端后端（`local, docker, modal, daytona, vercel_sandbox, ssh` — `tools/terminal_tool_backends.py:51`），环境模块内置在 `tools/environments/` 下。DSH 的模型更深：替换整套 fs/shell/subprocess seam，而非为单个工具选后端——这正是官方支持容器的最好论据，也是本设计"为收编而写"的原因。

## 3. 架构总览

### 3.1 家族布局

工作命名沿用 ssh 家族约定——一个不带后缀的传输包（连接 + 协议 + helper）、每个被替换 seam 一个包、一个私有构建载体（`packages/ssh/README.md:23-29`）：

| 包（工作名） | 提供 | 对应 | 配置？ |
|---|---|---|---|
| `dsh-docker` | `ctx.docker` — 连接、helper 身份、传输生命周期 | `dsh-ssh` | **是——家族中唯一带配置的包** |
| `dsh-fs-docker` | `ctx.fs`（`extends FileSystem`） | `fs-ssh` | 否（`inject: ['docker', 'sandboxPolicy']`） |
| `dsh-subprocess-docker` | `ctx.subprocess`（`extends SubprocessRuntime`） | `subprocess-ssh` | 否（`inject: ['docker']`） |
| `dsh-sandbox-docker` | `ctx.sandbox`（`extends SandboxProvider`） | `sandbox-ssh` | 否（`inject: ['docker']`） |
| `dsh-docker-helper-runtime` | 私有 SEA（单可执行应用）构建载体（无服务） | `ssh-helper-runtime` | private:true |
| `dsh-docker-policy-ceiling` | §6 默认值：给 `sandbox-policy` 行加顶 | —（新增，无 ssh 对应物） | 一个布尔值 |

最终命名由上游在收编时定夺；**形状**才是要点：一个传输家族由"它的包各继承哪些 seam 基类"完整描述。

### 3.2 helper 在容器内——组合而非重实现

helper 运行**在容器内**，在自己的私有 cordis Context 里挂载本地 provider 栈——`SandboxedFileSystem`（`dsh-fs-sandbox`）、`LocalSubprocessRuntime`、`LocalSandboxProvider`，另加 `SandboxPolicyService` 与 `SessionProjectionRegistry`——与 ssh helper 完全同构（`packages/ssh/ssh/src/helper.ts:28-36`）。线协议层是一个轻量、对每个请求全量校验的分发器，把每个 seam 方法 1:1 暴露为命名空间方法（`fs.*`、`process.*`、`terminal.*`、`sandbox`、`executable`），承载于一套**自定义帧协议**：4 字节大端长度前缀 + JSON 体，帧类型 `request|result|error|cancel`，错误码端到端保真（`packages/ssh/ssh/src/protocol.ts:36-41,50-55,134-204`）——不是通用 RPC 标准；Stage B 原样复用（§5.1）。容器提供外层内核/文件系统边界；逐调用策略语义由容器内 sandbox 执行——与任何 DSH 主机一致：

- 策略在宿主侧逐调用解析（`ctx.sandboxPolicy.resolve()`），provider 永不自持模式状态（`packages/sandbox/sandbox-policy/src/index.ts:197-205`）。
- 执行侧主机自行规范化根路径——"a local host must not canonicalize a remote path"（`sandbox-policy/src/index.ts:36-57`）；`additionalWritableRoots` "checked on the remote host"（`packages/sandbox/sandbox/src/index.ts:48`）。
- 五个 fs 变更方法全部把解析后的逐调用策略发上线路（`packages/ssh/fs-ssh/README.md:32`）。

### 3.3 不被替换的部分：shell 与终端

- **`ctx.shell` 保留。** ssh 家族恰好提供 `ctx.ssh`、`ctx.fs`、`ctx.subprocess`、`ctx.sandbox`——没有 shell 包（`packages/ssh/README.md:23-29`）。同一批 bash 执行器原样运行：`SandboxBashExecutor extends LocalBashExecutor`，`inject = ['subprocess','sandbox','sandboxPolicy']`（`packages/shell/bash-sandbox/src/index.ts:45-46`），经 `ctx.sandbox.confine` 约束 `['bash','-c',command]`、经 `ctx.subprocess` 起进程（`bash-sandbox/src/index.ts:187-189`）。容器家族占住这些行后，所有 shell 工具无需任何 shell 专属代码即迁入容器。shell 事实发现走 subprocess seam（`terminalEnvironment()`；`packages/ssh/subprocess-ssh/tests/shell-discovery.spec.ts:8-36`）。
- **`ctx.terminals` 保留。** 它是具体的注册表而非 provider 槽位（`packages/terminal/terminal/src/index.ts:104-118`）；`terminal-bash` 会话包装 `SubprocessTerminalHandle`（`terminal-bash/src/session.ts:279`），由容器 subprocess provider 经 `spawnTerminal` 供给。全生命周期 sandbox 围栏适用；受限模式要求同世界 `ctx.sandbox` provider——本家族恰好提供（`terminal-bash/README.md:49,70`）。

### 3.4 组装方式

Cordis bundle-patch 按 id 成行、后写覆盖；每个服务槽位一个实现（`packages/bundle/base/cordis.patch.yml:1-13`；`packages/subprocess/subprocess/src/index.ts:89-93`）。容器 profile 按 id 替换基础行 `subprocess`、`sandbox`、`fs-sandbox`，加上 `dsh-docker` 连接行，可选加顶级行。标准行序对齐发布校验器的组装：projections → policy → connection → providers（`scripts/verify-ssh-helper-artifact.ts:84-95`）。目前没有内置 preset 包含替换家族——激活方式是自定义 profile（`packages/ssh/ssh/README.md:28`）。

## 4. Stage A — 生命周期管理的容器 + 原版 `dsh-ssh`

### 4.1 概念

上游零改动：原版 `dsh-ssh` 家族连接容器内 sshd，唯一的新代码是一个小型**生命周期插件**，端到端掌管这个容器。它不触碰任何 seam，只负责把连接的前提条件物化出来。

### 4.2 生命周期插件职责

1. **镜像锁定**：首次使用时把配置的镜像 tag 解析为 manifest digest 并记录，此后一律按 digest `docker create`；复用时发现漂移即拒绝（§7）。
2. **创建**容器：sshd 入口、工作区**以宿主/容器同路径 bind-mount**（路径拼写契约，§9）、端口**仅发布在 127.0.0.1**（Stage A 必须桥接网络——§8）、用户映射可配置（Hermes 的 `docker_run_as_host_user` 是 UX 先例，`cli-config.yaml.example:498`）。
3. 经 Docker 控制通道**取出临时 host key**，以 `[host]:<port>` 拼写写进插件自有的 `known_hosts` 文件。
4. 往插件自有的 ssh-config 文件写**受管 `Include` 块**（被 `~/.ssh/config` 引用）——alias、`HostName 127.0.0.1`、固定 `Port`、`UserKnownHostsFile`、`StrictHostKeyChecking yes`。这是被 schema 逼出来的：`host` 就是 OpenSSH alias，**没有任何 `port`/`user`/`knownHostsFile` 字段**（`packages/ssh/ssh/src/index.ts:33-69`），alias 正则也不容 `:`（`host:port` 不可能）。
5. **注入 helper**：`docker cp` 工件（Stage A 默认 `executable` SEA 形态——`ssh-helper-runtime` 已产出 node24-linux-x64/arm64 目标，两种容器架构全覆盖、镜像内无需 Node；`ssh-helper-runtime/README.md:30-47`），计算 SHA-256，把 `helperHash` 写进产出的连接行。
6. **产出 `dsh-ssh` 行**：`host` = 受管 alias，`launch: {kind:'executable'}`，`helper`、`helperHash`、`workspace` = 同路径 bind-mount；线路默认值（`requestTimeoutMs` 30 s、`maxFrameBytes` 64 MiB、`maxPending` 128、`leaseMs` 30 s）来自 schema（`ssh/src/index.ts:60-69`）。
7. **销毁**：`docker rm -f`、移除 ssh-config 块与 `known_hosts` 条目。helper 侧由租约/心跳自终止（`ssh/src/index.ts:321-326`；`helper.ts:85-88`）及 `/tmp/dsh-ssh-*` 清理覆盖。

### 4.3 信任模型

`BatchMode=yes`、`StrictHostKeyChecking=yes`、无 agent 转发、无交互回退是**硬编码**（`ssh/src/index.ts:299-303`）。Stage A 因此把信任锚定在**本地 Docker API 控制权，而非网络 TOFU**：创建容器的插件与写下连接唯一会接受的 host key 的是同一个进程；握手期校验的 helper digest（`hello.hash`，`helper.ts:115`；比对在 `index.ts:316`）正是同一插件注入工件的 digest。没有任何"首次"信任。

### 4.4 约束

- 客户端平台守卫为 linux/darwin（`ssh/src/index.ts:90`）——Docker Desktop 宿主没问题；容器是 linux，两种 SEA 目标都覆盖。
- 流转发依赖 ssh control master 与 **streamlocal**（`ssh -O forward -L localUnix:remoteUnix`，`index.ts:163-171`）；容器化 sshd 下的 streamlocal 预期可用，但是**原型验证项**（§13）。
- Stage A 无法 `--network none`：sshd 必须可达。真正的断网随 Stage B 到来。

### 4.5 本设计承担的运营边界

1. **孤儿恢复。** 生命周期插件给自己的容器打标签（`dsh.container`、profile id）。启动时发现残留容器即**重建**——容器是无状态执行器：会话存储、策略与转录本都在宿主侧，重建只损失运行中的进程，与远端主机崩溃同构。helper 侧早由租约到期清理（`helper.ts:85-88`）。
2. **并发。** 默认一 profile 一容器，并发会话共享——如同并发会话共享一台 ssh 主机；会话级状态按 `policy.sessionId` 键控（§3.2）。逐会话独立容器作为配置项提供，换取更强隔离、付出镜像启动延迟。
3. **资源上限。** `cpu`/`memory`/`pids` 是家族 `Config`，直通 `docker create`——保守默认值，不进策略词表（§8）。
4. **macOS 注意。** Docker Desktop 的文件共享必须覆盖工作区路径，否则同路径 bind-mount 失败；插件检测到即以可操作的报错终止——§9 的路径一致前提依赖于此。

以上各项平移到 Stage B：连接服务承担同样职责（§5.2）。

## 5. Stage B — 原生 Docker 家族

### 5.1 传输

`docker exec -i <container> <helper-entry>` 的 stdio 承载同一套帧协议（§3.2），带自己的协议字面量（ssh 家族以 `SSH_PROTOCOL_VERSION = 3` 为线协议版本化，`protocol.ts:10`；docker 家族从 1 起）与同一套握手：`hello` → digest + 协议 + launch 形态校验，全部通过前插件不就绪（`ssh/src/index.ts:310-318`）。

### 5.2 消失的东西

无 sshd、无 `~/.ssh/config` 管理、无 `known_hosts`、无 control master、无端口发布。信任收敛为 **Docker API 访问权 + 锁定的镜像 digest**。生命周期插件的职责并入 `dsh-docker` 连接服务。

### 5.3 流

容器内的逐流 TLS-PSK socket 服务原样保留（每端点铸 256 位能力令牌、仅经管理信道下发；密码套件与身份钉死；`helper-processes.ts:423-444`；`stream-security.ts:6-25`）。宿主侧把 ssh 转发替换为逐流 `docker exec` 中继（在容器内 exec 一个微型 socket 拨号器）；备选方案（守护进程附着的代理）留给原型抉择。

### 5.4 保持后端无关的部分

传输 seam 刻意做窄（exec stdio + 流 socket）。云执行器（Modal/Daytona）将是同一 helper 之上的新传输——本设计不做，留给上游路线图（§13）。

## 6. 安全策略：`danger-full-access`（Q1）

### 6.1 上游今天的实际行为（已核验）

1. 该模式下消费者**完全绕过 seam**：工具直接 spawn 原始 argv，从不调 `ctx.sandbox`（`docs/subsystems/sandbox.md:23`）。
2. 在替换了 seam 的世界里，该 argv **在目标世界内裸跑**——ssh 场景即远端主机；连接层不加策略开关（`sandbox-ssh/README.md:30`）。
3. `helper.ts:159`（"Unconfined argv does not need a sandbox wrapper"）是 `confine` RPC 的误用防护，正常消费者到不了那行。

因此今天的语义是 **(c) 世界内裸跑**——既非 (a) 拒绝，也非 (b) 回落宿主。(b) 在现有 seam 下不可实现：subprocess 的 spawn spec 不携带 policy（`packages/subprocess/subprocess/src/types.ts:77-107`），provider 看不到一次 spawn 是否 unconfined，更无从改道——且每个服务槽位只容一个 subprocess 实现（§3.4）。(a) 可实现，即本家族的默认。

### 6.2 本家族的立场

- **默认——拒绝，经策略顶盖。** 可选的 `dsh-docker-policy-ceiling` 行替换 `sandbox-policy` 行，其 `resolve()` 先委托基础解析器，再在解析结果为 `danger-full-access` 且未开 opt-in 时抛 `SandboxUnsupportedPolicyError`，附可操作的指引。UX 缓冲（尽力而为、明示标记）：在 `approval/request` 瀑布上挂监听器，升级到 `danger-full-access` 的请求在弹窗前即拒——升级理由是模板化字符串（`escalate sandbox to ${mode}: …`，`escalation.ts:189-196`），预过滤器按模板匹配；但**强制点在 resolve 顶盖**，预过滤只是体验优化。顶盖行与传输无关——它替换的是 `sandbox-policy` 行，Stage A（原版 `dsh-ssh`）与 Stage B 同样适用。
- **Opt-in——世界内裸跑（上游语义）。** 一个配置布尔移除顶盖；`danger-full-access` argv 随即在容器内裸跑。容器边界本身不受该模式影响——这正是上游"不受限"的含义。
- **字面回落宿主——需要上游。** 列为开放问题 §13.5：需要携带策略的 spawn spec 或受认可的双世界组合；现有 seam 两者皆无。
- **两条路径都过同一套阶梯测试。** 测试矩阵跑遍 策略模式 × 升级结果 ×（默认 | opt-in），断言宿主侧 `approveEscalation`/`ctx.approval` 流（`escalation.ts:172-206`；`packages/interaction/user-approval/src/index.ts:242-332`）除顶盖外行为一致。

**为何首日选择拒绝而非照搬上游**：用户启用容器 profile 通常正是要一条硬边界；无声裸跑——哪怕在容器内——是唯一让模型完全脱掉包装的模式。拒绝只让想要上游原语义的用户多写一行配置，同时保住默认行为的诚实。若上游裁定"容器完全跟随 ssh 语义"，顶盖插件删除，本节缩成一条引用。

## 7. 镜像锁定与供应链

1. **镜像**：创建期按 manifest digest 锁定；tag→digest 解析结果留档；复用遇漂移即拒。连接状态对外可见。
2. **helper 工件**：`helperHash` 配置锁定，握手期对照 helper 自算的 `hello.hash`（`helper.ts:115`；`index.ts:316`）；Stage A 的哈希由注入工件的同一插件计算。
3. **SEA 归档**：`manifest.json` 携带源 commit、内嵌 Node 版本、协议字面量、逐文件 digest 与权限（`ssh-helper-runtime/README.md:30-47`）。
4. **运行时依赖**：精确锁定（ssh 家族钉 `zod: "4.4.3"`；同一策略）。
5. **明示的限度**：digest 锁定不防御恶意主机；受信基础设施边界是"写明"而非"假装不存在"（`sandbox-ssh/README.md:67-68`）。

## 8. 网络可见性（Q4）——仅 Config

策略词表刻意不含网络/进程可见性（模式 schema 只有 `mode`/`workspaceRoot`/`additionalWritableRoots`/`sessionId`，`sandbox/src/index.ts:40-60`），因此网络姿态是家族 `Config` 而非策略：

- Stage A：桥接网络 + 环回发布的 sshd 端口（被迫如此，§4.4）。
- Stage B：`networkMode` 配置，**默认 `none`**（传输走 Docker socket，容器完全不需要网络），`bridge`/自定义网络为 opt-in。

现在不提议跨 provider 的网络策略扩展；若上游日后想要，本 Config 即迁移面。

## 9. 混合世界组合（Q3）

机制上成立：服务行彼此独立，profile 可以让 `fs` 留在宿主（`fs-local` + `fs-sandbox`）而 `subprocess`/`sandbox` 换成容器 provider。工作区以同路径 bind-mount（§4.2.2）后，两个世界对路径拼写达成一致，满足执行世界拼写规则（`sandbox-policy/src/index.ts:36-57`）。LSP 留宿主侧——最初的动机。

诚实地列出保留意见：

1. 假设同世界的消费者存在："replacing providers alone does not make [host-assuming web views] remote-aware"（`docs/subsystems/ssh.md:27`）。*反向*组合（宿主 fs + 容器 exec）对 ssh 也是新事物；上游背书是开放问题 §13.3。
2. 混合组合下，fs 变更由宿主侧 `fs-sandbox` 按宿主路径围栏，而 `confine()` 来自容器 provider——路径一致时自洽，但**原型验证后再推荐**（§13）。
3. §6 顶盖在宿主侧、与世界无关；混合组合不改变阶梯行为。

## 10. 版本走廊（Q5）

上游以 caret 范围发布家族 peer——仓内 peer 为 `workspace:*`，发布后解析为 caret（对 npm registry 核验）；只有真正的运行时依赖（如 `zod: "4.4.3"`）精确锁定——因此仓外家族应当：

1. peer 声明为对齐**最新已测** DSH 版本的 caret 范围（不放宽）。
2. README 发布已测 DSH 版本表，随版本更新。
3. 跟进已发布的 upgrade guide；协议字面量 + 握手校验让不兼容的线协议变更在连接期大声失败，而非会话中途。
4. 提议上游为第三方家族把这条走廊写成约定（开放问题 §13.4）。

## 11. Stage A → Stage B 迁移路径

**不变的部分**（seam 契约及其上的一切）：

- 三个 provider 的对外表面（同 seam 基类、同服务名、同逐调用策略流）。
- helper：同私有 Context 组合、同线方法、同租约/心跳/清理语义。
- 宿主侧策略解析、升级阶梯、审批流；面向模型的拒绝/升级标记逐字保留。
- profile 里 `subprocess`/`sandbox`/`fs-sandbox` 的行 id。

**变化的部分**：

| 维度 | Stage A | Stage B |
|---|---|---|
| 连接行 | `dsh-ssh`（+独立生命周期插件） | `dsh-docker`（生命周期并入） |
| 传输 | ssh exec 通道 + control-master streamlocal 转发 | `docker exec` stdio + 逐流 exec 中继 |
| 信任机制 | alias + 插件写入的 `known_hosts` + 受管 ssh-config 块 | Docker API 访问 + 镜像 digest |
| 网络 | bridge、环回端口 | 默认 `none` |
| helper 工件 | 生命周期插件注入、哈希写入配置 | 烧进锁定镜像（同一握手校验） |
| 额外插件 | 生命周期插件（新代码）；顶盖行同样适用（§6） | policy-ceiling 行（§6） |

迁移 = 换行 + 改配置；会话感知不到语义差异，除了网络默认值。

## 12. 收编友好的结构与测试策略

从 ssh 家族照搬的约定，让收编成为搬移而非重写：

1. 一个带配置的传输包；provider 零配置（仅 `static inject`）——配置目录里每个家族恰好一个可配置包（`packages/preset/agent-preset/skills/cordis-composition-reference/references/packages.md:448-449`；生成的配置块见 `docs/config-catalog.md:3488-3533`）。
2. 以继承共享抽象 Service 基类替换 seam；不支持的方法留给基类默认（fs `watch()` 先例，`fs-ssh/README.md:70`）。
3. 家族内版本锁步；provider 以 `workspace:*` 风格 peer 传输包；helper 载体 `private: true` 携带封闭嵌入集。
4. 双语 README（`README.md` + `README.zh.md`）+ 服务描述 locale 目录——家族惯例。
5. **测试，两层 + 对抗**：每包 vitest，mock 传输的单元层（`ctx.provide('docker', { request })` 模式）；共享 fixture 的真 helper 集成层；环境变量门控的可选 live e2e；针对流能力重放、socket 改绑、协议边界的专项对抗 spec——ssh 家族的 live e2e 甚至会用全零 PSK 拨流 socket 并断言 `{connected: true, secure: false}`（`packages/ssh/ssh/tests/live.e2e.ts:66-95`）；我们沿用同样的"攻击即测试"纪律。

## 13. 给上游的开放问题

1. **Q1 裁决**：(c) 世界内裸跑（今天 ssh 语义）vs (a) 默认拒绝（本设计的顶盖）vs (b) 需上游 seam 支持的回落宿主。若上游选 ssh 原语义，顶盖插件删除。
2. **Q2**：`dsh-ssh` 的 Config 会不会长出临时主机字段（`port`/`user`/`knownHostsFile`/`trustedHostKey`），从而让 Stage A 的受管 ssh-config 块彻底消失？还是受管块就是长期形态？
3. **Q3**：宿主 fs + 容器 exec 的混合组合是否获得契约层面的背书？除已记录的假设同世界消费者外还有无同世界不变式？
4. **Q5**：上游是否会把第三方版本走廊（§10）写成约定？
5. **回落宿主**（§6.1 选项 (b)）：需要携带策略的 spawn spec 或双世界组合——到底要不要？
6. **streamlocal 转发**在 Stage A 的容器化 sshd 下：预期可用，原型验证。
7. **收编标准**：上游收编容器家族前想看到什么（采用量、测试覆盖、基准）？

## 附录 A — seam 合规矩阵

| # | 义务（来自 seam 契约） | 满足处 |
|---|---|---|
| 1 | 经 `ctx.sandboxPolicy.resolve()` 消费逐调用策略；永不自持模式 | §3.2 |
| 2 | `workspaceRoot`/`additionalWritableRoots` 用执行世界拼写；执行侧主机逐调用校验 | §3.2；同路径 bind-mount §4.2 |
| 3 | 用 `workspaceWritableRoots`/`writableRoots` 推导做白名单 | helper 原样挂载 `dsh-sandbox-local` §3.2 |
| 4 | 永不为 `danger-full-access` 执行策略（消费者绕过 seam） | §6.1；顶盖在宿主侧 §6.2 |
| 5 | 按 `policy.sessionId` 键控会话状态 | 继承自本地 provider §3.2 |
| 6 | `SandboxProvider.confine(argv, policy, signal?) → ConfinedArgv`；失败即关；禁止静默放行 | `dsh-sandbox-docker` §3.1 |
| 7 | `FileSystem`：全部 16 个抽象方法；五个变更方法带尾部 `sandboxPolicy`；`watch()` 可拒绝；`processPathFromHostPath` 可为 undefined；`sandboxMode` getter 诚实；仅 `FsError` 码；歧义变更不重放 | `dsh-fs-docker` §3.1 |
| 8 | `SubprocessRuntime`：`resolveExecutable`/`terminalEnvironment`/`spawn`（同步句柄）/`spawnTerminal`；无 policy 参数；共享环境擦洗；歧义启动不重放 | `dsh-subprocess-docker` §3.1 |
| 9 | shell：委托，不替换 | §3.3 |
| 10 | 终端：注册/搭车 `TerminalBackend`，不继承注册表 | §3.3 |
| 11 | 一个连接服务拥有传输/身份；provider 零配置 | §3.1、§12.1 |
| 12 | Cordis 行按 id、后写覆盖；每槽一实现 | §3.4 |
| 13 | 升级留在宿主侧；容器只在升级后的那一次重试执行获批模式 | §6.2 |
| 14 | 面向模型的方言保留：`[sandbox: file access denied under <mode> mode]` + 升级提示 + `FS_SANDBOX_DENIED` | 逐字继承 §11 |
| 15 | 诚实的限度：无网络/进程可见性词表；partial 保持 partial；受信基础设施边界写明 | §8、§7.5 |

## 附录 B — Stage A → B 契约差异

见 §11 表。线协议、helper 行为与全部 seam 契约不变；移动的只有传输、信任机制与生命周期归属。
