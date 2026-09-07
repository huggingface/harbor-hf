# CLI-only Harbor image scaffold

This image only runs `harbor --help` by default. It is not a supported runner.
The parent worker, private Sandbox adapter, and image publication workflow have
been removed. Do not attach credentials or use this scaffold for execution.
The retained Dockerfile can be built locally for dependency compatibility only.
