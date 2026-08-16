---
title: Harbor Results
emoji: ⚓
colorFrom: gray
colorTo: blue
sdk: docker
app_port: 7860
short_description: Compare reproducible Harbor benchmark runs
startup_duration_timeout: 10m
---

# Harbor Results

This directory describes the current separate read-only results deployment. The
approved [control service specification](../../docs/CONTROL_SERVICE.md) replaces
it with the React application served by the private TypeScript control Space.
Do not use this deployment as a second production frontend after that switch.

Read-only benchmark results published by
[`harbor-hf`](https://github.com/huggingface/harbor-hf). The Space reads sanitized,
normalized public datasets at immutable revisions. Canonical sessions, task
contents, and raw execution artifacts remain in private storage.
