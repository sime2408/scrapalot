---
title: Local AI Hardware — Community Knowledge
tags: [hardware, local-ai, strix-halo, dgx-spark, mac]
source: Discord #general
captured: 2026-06-20
---

# Local AI Hardware

The dominant topic. Core philosophy in the channel: **specs alone are useless** — you
must understand fundamentals, then test on *your* workflow. But newcomers need concrete
data before they spend thousands.

## The "Iron Triangle" (from Manolo's substack)

You can optimize **two of three**, never all: **memory capacity · memory speed (tok/s) · cost**.
Manolo segments buyers into four archetypes (Solo Coder, Nomad, Generalist, Shared Server
Node) and says: match hardware to your *workflow identity*, not to a spec sheet.

> Key recurring insight (snowy2k3, kerikayak): **memory bandwidth is the real bottleneck**,
> not headline VRAM. A 5-year-old M1 Max (400 GB/s) beats Strix Halo (256 GB/s) and DGX
> Spark for responsiveness.

## Newcomer questions the community keeps answering (xlan2023)

- Mac 64/128 GB vs PC with 5090?
- What models can I *realistically* run?
- Can I do LoRA fine-tuning on this?
- Will it support coding agents, RAG, long-context?
- What tok/s are people *actually* seeing?

## Specific machines discussed

| Machine | Notes from members |
|---|---|
| **AMD Strix Halo (Ryzen AI Max+ 395, 128 GB)** | kerikayak (Framework desktop): loves it but "insufferably slow" on 70B+; 96 GB usable VRAM locked in BIOS (mods exist); wrappers misestimate memory → frozen loads. ROCm ecosystem smaller than CUDA. |
| **GMKtec EVO-X2 (same 395 chip, 128GB/2TB, ~AUD 3300)** | c_h_a_r_m considering for AI + algo-trading + k8s. Claims of Qwen3:235B @ 11 tok/s disputed by kerikayak (235B only viable ~Q2, ~2 tok/s realistically). |
| **NVIDIA DGX Spark** | zadok7.eth chose it for **fine-tuning/training** (CUDA has more training methods). comradekukr runs vLLM on it. |
| **Mac Studio M5 Ultra (256GB, upcoming)** | expo6386 waiting for it; wants ≥128 GB unified. Several say "just wait for the Mac" if budget >$5k. |
| **GB300 DGX Station** | morfir — enterprise local dev; ~1600–2100 W power draw (jokes about replacing the space heater). |
| **2× DGX Spark / dual R9700** | considered alternatives; Spark bandwidth criticized. |

## Practical takeaways

- **Rent first, buy later** (zadok7.eth): rent a model, prove it in your workflow, *then*
  pick hardware around the specific model + runtime (CUDA vs MLX vs ARM-optimized llama.cpp).
- **Quantization reality**: Q4 is the usual usable sweet spot; Q2 on 235B = "slow and stupid".
- Context headroom matters: comprehension of 70B+ is wasted if context caps out.
- Cooling: immersion cooling floated (chris.via.egnatia) — doesn't void warranty but messy.

## Community gap → opportunity

**future4200 + xlan2023** want a **live, community-validated database** of
`hardware → models run → runtime → tok/s → use case → notes`, kept current by a
**"daily research agent"** (the landscape changes too fast for a static list).
manolo.uk offered to host it as a page on the ResonantOS website.

→ This is a textbook **RAG + deep-research** use case. See `ENGAGEMENT-scrapalot.md`.
