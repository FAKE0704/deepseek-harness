# Container Execution Providers — Design Proposal

Design proposal for a **container-execution provider family** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): full capability-seam replacement modeled on the in-repo `dsh-ssh` family — Stage A (stock `dsh-ssh` + a container lifecycle plugin), Stage B (native `docker exec` transport).

- [Design document (English)](design.md)
- [设计文档（中文）](design.zh.md)
- Upstream discussion: [deepseek-ai/deepseek-harness#9120](https://github.com/deepseek-ai/deepseek-harness/discussions/9120)

**Status**: draft v0.1 — rapid generation, AI-assisted; every upstream claim is cited `path:line` against `deepseek-ai/deepseek-harness@master` and machine-verified at drafting time. See the authorship note in each document.

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
