---
'e2e': patch
---

An agent step whose model answers a forced `complete_step` turn with another tool no longer fails as `MODEL_PROVIDER_FAILED`. The call goes back to the model as an error and the turn is asked again within the step's turn budget; a model that never concludes fails the step with `STEP_NO_CONCLUSION`.
