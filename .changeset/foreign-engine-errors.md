---
"e2e": patch
---

An error an engine throws with a runner code, such as `INVALID_LOCATOR` for an unsupported selector, keeps its code and category when the engine is loaded from `e2e.config.ts`. It was reported as an infrastructure `ENGINE_FAILURE`.
