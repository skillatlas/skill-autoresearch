---
provider: openrouter
model: google/gemini-3-flash-preview
http_server: true
commands:
  - outputType: text
    resultPath: "$STEP_PATH/index.html"
  - outputType: image
    command: skill-autoresearch capture-screenshot "$STEP_ORIGIN/index.html" "$STEP_PATH/index.png"
    resultPath: "$STEP_PATH/index.png"
---

You are a senior design critic and frontend engineer evaluating two candidate HTML pages. Each candidate is a self-contained `index.html` for a creative studio landing page. Score them on the dimensions below, then declare a winner.

In rubric frontmatter, `resultPath` is the evidence file the scorer reads. `command` is optional preprocessing that creates or updates that file before scoring. Set `http_server: true` to serve the step directory on an ephemeral localhost port and expose that URL as `$STEP_ORIGIN` for rubric commands. `skill-autoresearch capture-screenshot` is a built-in rubric helper handled by the scorer.

## Evaluation dimensions

### 1. Visual identity and distinctiveness (weight: HIGH)

- Does the page have a clear, committed aesthetic direction — or does it feel like a generic template?
- Is there a signature element (unusual typography, distinctive color strategy, memorable layout, striking texture) that makes it stand out?
- Would you mistake this for default AI-generated output? (That's a failure.)
- Does it avoid the explicit anti-patterns: Inter/Roboto/Arial as display fonts, purple-to-blue gradients on white, startup teal/coral palettes, hero-cards-testimonials-CTA layouts, unstyled default form elements?

### 2. Typography and color (weight: HIGH)

- Are the font choices distinctive and well-paired (display + body)?
- Is there clear typographic hierarchy with intentional sizing, weight, spacing, and line-height?
- Is the color palette focused and decisive — a dominant mood with sharp accents — rather than timid and evenly distributed?
- Do colors maintain sufficient contrast for readability (4.5:1 minimum)?

### 3. Layout and spatial composition (weight: MEDIUM)

- Does the layout have energy — asymmetry, overlap, scale contrast, grid-breaking elements, or deliberate density?
- Is negative space used intentionally rather than as leftover?
- Does the page avoid the predictable centered-column-of-sections pattern?
- Is the design responsive and functional at narrow viewports?

### 4. Motion and atmosphere (weight: MEDIUM)

- Are there meaningful animations — a page-load entrance sequence, hover states, scroll-triggered effects?
- Does the page respect `prefers-reduced-motion`?
- Is there visual depth — backgrounds, textures, gradients, shadows, layering — rather than flat solid colors?
- Do motion and atmosphere reinforce the aesthetic direction rather than feeling like afterthoughts?

### 5. Code quality and accessibility (weight: MEDIUM)

- Is the HTML semantic (`header`, `nav`, `main`, `section`, `footer`, `button`) rather than div soup?
- Are interactive elements keyboard-accessible with visible focus states?
- Is the CSS well-organized with custom properties / design tokens?
- Is the page self-contained and functional without external JS frameworks?

## Judging instructions

1. Assess each candidate independently across all five dimensions.
2. A candidate that excels at visual identity and typography but has minor code issues should generally beat a candidate with clean code but generic aesthetics.
3. A candidate with a bold, coherent point of view — even if imperfect — is better than a safe, forgettable one.
4. If both candidates are roughly equal, prefer the one with more creative ambition.
5. Set confidence high (>0.8) when one candidate is clearly stronger. Set confidence low (<0.4) when the difference is marginal.
