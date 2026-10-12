---
"@e2e-dev/mobile": patch
"@e2e-dev/limrun": patch
---

Update agent-device to 0.21.25, the first release whose daemon loads WebDriver provider plugins such as `@agent-device/testmu`, which `@e2e-dev/testmu` needs on the same agent-device copy as `@e2e-dev/mobile`. agent-device 0.21.22 loads only plugins that return a native provider runtime, so it refuses that plugin. `@e2e-dev/limrun` pins the same version as `@e2e-dev/mobile`, so its `agent-device` peer moves to 0.21.25 too.
