You are improving the `frontend-design` skill in `./skills/frontend-design/SKILL.md`.

Review the current SKILL.md and make ONE targeted improvement. Choose the single change that would most increase the quality and distinctiveness of generated frontend output.

## Possible improvement directions (pick ONE per iteration)

- **Improve the creative process** — Strengthen guidance on *how to think* about design decisions rather than dictating specific outcomes. Good: "Derive your color palette from the content's mood and purpose." Bad: "Use emerald green (#0D9F6E) with warm grey (#4B5563)." The skill should teach taste, not prescribe values.
- **Add a missing dimension** — If the skill lacks guidance on a topic that materially affects output quality (e.g. dark mode treatment, illustration style, icon usage, scroll behavior, loading states, empty states), add a focused section.
- **Sharpen anti-patterns** — Expand the list of things to avoid with specific, testable examples. "Avoid generic layouts" is vague; "Never use the exact pattern: full-width hero → three equal-width cards → centered testimonial → CTA banner" is actionable.
- **Improve variety mechanisms** — Add rules that force variety across generations without dictating what the outputs should converge toward. Good: "Never reuse the same display font across consecutive outputs." Bad: "Use Clash Display or Cabinet Grotesk." The goal is divergence, not convergence on a different set of specifics.
- **Tighten code quality guidance** — Add specific patterns for accessible focus states, reduced-motion handling, fluid typography with `clamp()`, or responsive image strategies.
- **Strengthen design principles** — Replace prescriptive values with transferable principles. Good: "Typography hierarchy should create clear visual rhythm through contrast in scale, weight, and spacing." Bad: "Set headings to 4.5rem with 700 weight and -0.02em letter-spacing." Principles guide infinite good outputs; prescriptions produce one.

## Critical constraint: DO NOT over-specify

The skill should guide *how to design*, not dictate *what to design*. Every edit must pass this test:

> "Does this guidance help produce a RANGE of excellent, varied outputs — or does it push every output toward the same specific look?"

**DO NOT** add specific font names, hex colors, pixel values, or exact CSS property values to the skill. These cause every generation to converge on the same aesthetic, which is the opposite of the goal.

- Bad: "Use Clash Display at 4.5rem with #0D9F6E accents"
- Bad: "Apply 120px vertical padding with a 1.618 golden-ratio scale"
- Bad: "Set border-radius to 0 for brutalist, 24px for soft"
- Good: "Choose fonts that have personality — avoid the safe defaults everyone reaches for"
- Good: "Build a color palette that reinforces the emotional tone of the content"
- Good: "Let the aesthetic direction dictate spatial rhythm — dense and energetic, or open and contemplative"

If you find yourself writing a specific value (a font name, a color, a number), ask: "Will this make outputs more varied or less varied?" If less varied, rewrite it as a principle instead.

## Idea selection

Before you edit the file, pressure-test your improvement choice with a short self-questioning loop:

- Come up with one candidate improvement idea and name it clearly.
- Assume the first idea is probably too obvious, too safe, or too close to the current text.
- Come up with a second candidate improvement idea and name it clearly.
- Compare the two: which would do more to improve the quality and distinctiveness of generated output?
- If the answer is not obvious yet, generate another candidate and keep comparing until one idea is clearly strongest.
- Only then make the single surgical edit.

## Rules

- Do NOT rewrite the entire file. Make a surgical, focused edit.
- Do NOT remove existing guidance that is already effective.
- Do NOT add generic filler or obvious advice. Every sentence must earn its place.
- Do NOT make the file longer than ~2500 words. If adding content, consider tightening or removing weaker existing content.
- Preserve the overall structure and voice of the document.
- The improvement should be something that would visibly affect the quality of generated HTML/CSS output.
