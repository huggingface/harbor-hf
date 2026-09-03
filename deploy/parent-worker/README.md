---
title: Parent worker image
author: Harbor-HF maintainers
date: 2026-09-04
tags: [deployment, harbor, jobs]
---

# Parent worker image

This image runs one Harbor job from `runs/<run-id>/run.json` on a writable
Bucket mount. Harbor starts each trial through its `hf-sandbox` environment.

Build from the repository root:

```bash
docker build -f deploy/parent-worker/Dockerfile .
```

Production uses the image digest. Do not configure a mutable tag in the control
Space.
