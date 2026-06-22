---
title: Models & Runtimes — Community Knowledge
tags: [models, vllm, quantization, qwen, nemotron]
source: Discord #general
captured: 2026-06-20
---

# Models & Runtimes

## Models in active use

| Model | Verdict from members |
|---|---|
| **Qwen3.6 35B-A3B-NVFP4** (RedHatAI) | comradekukr's reliable workhorse — solved an agentic task first try where Nemotron failed. |
| **NVIDIA Nemotron-3-Nano-30B-A3B-NVFP4** | ~2× faster than Qwen on Spark, but **more prompt-sensitive** and unreliable for agentic work (lied "task done", missing files). comradekukr: "banned from agentic work", kept as **classifier/researcher**. NVIDIA cookbooks badly out of date. |
| **DeepSeek Distill 32B / 70B** | mentioned as common local picks. |
| **Qwen3 72B / 235B** | 235B impractical on 128 GB unified (Q2 only, ~2 tok/s). |

## Runtimes

- **vLLM** — comradekukr on Spark: e.g. `Avg generation 73.4 tok/s, 2 concurrent reqs`,
  KV cache ~23M tokens, 44× max concurrency @ 512k tokens/req at 75% shared mem.
- **llama.cpp** — ARM/processor-specific optimizations.
- **Ollama** — common newcomer entry.
- **LMStudio** — kerikayak: stays current on Vulkan/ROCm runtimes; good on Strix Halo.
- **Lemonade** — AMD-specific, similar results to LMStudio on AMD.

## Hard-won gotchas

- **Silent model swaps** (zadok7.eth): a rented "Qwen 8B" silently became "9B" under the
  same provider tag — **tool calling broke**. Lesson: pin/verify, and test tool-calling
  reliability before building on a model. → led to building **LLM-probe** (see tools file).
- **NVFP4 / quantization** choice dominates real-world usability more than parameter count.
- Subagents splitting parallel work "kind of good" on Nemotron in a Hermes setup.

## Emerging strategy: small fine-tuned domain models

zadok7.eth's working theory (shared by several): **fine-tune small models on your own
domain knowledge** (coding patterns, knowledge docs) so they **outperform frontier models
on that narrow domain**, then run them cheaply all day on modest hardware. Training-method
availability (CUDA > MLX) is *the* reason some chose Spark over Mac.
