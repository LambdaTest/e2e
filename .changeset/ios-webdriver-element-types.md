---
'@e2e-dev/mobile': patch
---

iOS devices driven through agent-device's WebDriver runtime (hosted Appium clouds such as TestMu AI, BrowserStack, and AWS Device Farm) now resolve roles: the `XCUIElementType` prefix those sessions report (`XCUIElementTypeButton`) is dropped before the type is mapped, so `getByRole('button', …)` matches.
