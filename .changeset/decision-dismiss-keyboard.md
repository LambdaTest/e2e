---
"@e2e-dev/decision": patch
---

The decision executor offers `dismiss_keyboard` while an on-screen keyboard is showing and the engine can dismiss it. Before, a control the keyboard covered after typing (an iOS number pad over a submit button) could not be reached, and the step failed.
