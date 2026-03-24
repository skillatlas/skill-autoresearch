---
provider: openrouter
model: openai/gpt-4.1
outputType: text
resultPath: "$STEP_PATH/index.html"
---

Prefer the candidate with the higher score. When comparison evidence includes a skill diff, use it as supporting evidence about whether the changed guidance plausibly caused the observed improvement. Do not reward a better-sounding diff if the artifact itself is worse.
