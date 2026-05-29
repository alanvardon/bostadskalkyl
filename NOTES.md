# NOTES

Operational gotchas worth remembering. Not design docs — those live in `notes/`.

## Orchestrator pluggable steps (Phase 33)

### `script` steps must be executable and have a shebang

A `[[steps.*]]` step of `type = "script"` is run **directly** (the orchestrator
executes the file itself, it does not invoke `sh path`). That means the script
must be:

1. **Executable** — `chmod +x .orchestrator/scripts/your-step.sh`
2. **Have a shebang** on the first line — e.g. `#!/bin/sh` or `#!/usr/bin/env bash`

Miss either and the step fails at run time with a `StepError` ("could not be
executed"), aborting the workflow. The manifest loader checks that the script
*path exists* at load time, but it does **not** check the executable bit or the
shebang — those only surface when the step actually runs.

A non-zero exit from the script is treated as a failure and aborts the run
(its stdout/stderr becomes the abort reason).
