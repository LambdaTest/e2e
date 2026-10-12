---
"@e2e-dev/decision": patch
---

The decision executor's stall guard now counts an action that errored as no progress, so three actions in a row that failed or changed nothing on screen block the step. It used to look only at whether the page changed, and a ticking timer on screen changes it every time: a tap that failed with `APP_UNREACHABLE` again and again never tripped the guard, and the model could repeat it until it gave up and claimed the step failed. A skipped pick and a rejected `done` or `failed` claim also carry an error in the step's history, so they count toward the three as well.
