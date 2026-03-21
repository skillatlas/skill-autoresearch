---
name: frontend-design
description: Create distinctive, production-grade frontend interfaces with high design quality. Use this skill when the user asks to build web components, pages, artifacts, posters, or applications (examples include websites, landing pages, dashboards, React components, HTML/CSS layouts, or when styling/beautifying any web UI). Generates creative, polished code and UI design that avoids generic AI aesthetics.
license: Complete terms in LICENSE.txt
---

This skill guides creation of distinctive, production-grade frontend interfaces that avoid generic "AI slop" aesthetics. Implement real working code with exceptional attention to aesthetic details and creative choices.

The user provides frontend requirements: a component, page, application, or interface to build. They may include context about the purpose, audience, or technical constraints.

## Design Thinking

Before coding, understand the context and commit to a BOLD aesthetic direction:

- **Purpose**: What problem does this interface solve? Who uses it?
- **Tone**: Pick an extreme: brutally minimal, maximalist chaos, retro-futuristic, organic/natural, luxury/refined, playful/toy-like, editorial/magazine, brutalist/raw, art deco/geometric, soft/pastel, industrial/utilitarian, etc. There are so many flavors to choose from. Use these for inspiration but design one that is true to the aesthetic direction.
- **Constraints**: Technical requirements (framework, performance, accessibility).
- **Differentiation**: What makes this UNFORGETTABLE? What's the one thing someone will remember?

**CRITICAL**: Choose a clear conceptual direction and execute it with precision. Bold maximalism and refined minimalism both work - the key is intentionality, not intensity.

Then implement working code (HTML/CSS/JS, React, Vue, etc.) that is:

- Production-grade and functional
- Visually striking and memorable
- Cohesive with a clear aesthetic point-of-view
- Meticulously refined in every detail

## Frontend Aesthetics Guidelines

Focus on:

- **Typography**: Choose fonts that are beautiful, unique, and interesting. Avoid generic fonts like Arial and Inter; opt instead for distinctive choices that elevate the frontend's aesthetics; unexpected, characterful font choices. Pair a distinctive display font with a refined body font.
- **Color & Theme**: Commit to a cohesive aesthetic. Use CSS variables for consistency. Dominant colors with sharp accents outperform timid, evenly-distributed palettes.
- **Motion**: Use animations for effects and micro-interactions. Prioritize CSS-only solutions for HTML. Use Motion library for React when available. Focus on high-impact moments: one well-orchestrated page load with staggered reveals (animation-delay) creates more delight than scattered micro-interactions. Use scroll-triggering and hover states that surprise.
- **Spatial Composition**: Unexpected layouts. Asymmetry. Overlap. Diagonal flow. Grid-breaking elements. Generous negative space OR controlled density.
- **Backgrounds & Visual Details**: Create atmosphere and depth rather than defaulting to solid colors. Add contextual effects and textures that match the overall aesthetic. Apply creative forms like gradient meshes, noise textures, geometric patterns, layered transparencies, dramatic shadows, decorative borders, custom cursors, and grain overlays.
- **Interactive States**: Every clickable and focusable element needs a complete state story — default, hover, focus-visible, active, and where relevant, disabled. These shouldn't be afterthoughts; design them as part of the element's identity. Hover transitions should feel physical — elements that shift, lift, reveal, or transform rather than simply changing color. Focus states must be visible and beautiful, not just a browser default outline; treat them as a design opportunity. Use `prefers-reduced-motion` to offer graceful fallbacks. State transitions should have consistent timing curves and durations that match the overall motion personality — snappy for energetic interfaces, smooth and deliberate for refined ones.

### Anti-patterns: Specific traps to avoid

These are the telltale signs of generic AI-generated frontend. Each is testable — if your output matches any of these, redesign that element:

- **The default stack**: A full-width hero with centered headline → a row of three equal-width feature cards with icons above text → a testimonial section → a centered CTA button. This exact layout skeleton is the most common AI output. Break it structurally — vary column counts, use asymmetric grids, overlap sections, or eliminate sections entirely.
- **Safe font syndrome**: Reaching for the same well-known geometric sans-serifs across every generation. Before selecting a typeface, consider the content's personality — a poetry site and a fintech dashboard should never share the same typographic voice.
- **The purple-blue gradient**: Purple-to-blue or purple-to-pink gradients on white/light backgrounds have become the default AI color palette. Derive your palette from the content's mood, era, and audience instead.
- **Decorative sameness**: Rounded rectangles with soft shadows, blurred gradient blobs as background decoration, and pill-shaped buttons appearing together. These elements aren't individually bad, but their combination has become a cliché. If you use one, make the others sharp and unexpected.
- **Uniform spacing monotony**: Every section having identical padding, every card having the same gap, every element breathing the same amount. Vary spatial rhythm intentionally — some sections should be dense and compressed, others expansive.
- **Emoji-as-icon laziness**: Using emoji or generic icon libraries as the primary visual element in cards/features. Design custom visual treatments or use typography, color, and shape to create visual interest instead.

### Design matches content

Consider these before committing to a direction:

- **Challenge your first instinct**: Your default layout, color temperature, and font category are your rut. Name your first instinct explicitly, then design a second option that contradicts it structurally. Evaluate both honestly before proceeding.
- **Vary the entry point**: Not every page opens with a hero. Consider leading with typography, a provocative question, an interaction, a full-bleed image, a data point, or silence (negative space). The opening sets the entire tone — never default it.
- **Rotate color temperature**: If you're reaching for cool tones (blues, purples, teals), force yourself to explore warm palettes, earth tones, high-contrast monochromes, or desaturated neutrals with a single vivid accent. Let the content's emotional register — not habit — choose the temperature.
- **Alternate density and pace**: Consciously vary the ratio of whitespace to content. Some interfaces should feel like a magazine spread — open, rhythmic, contemplative. Others should feel like a cockpit — dense, efficient, information-rich. The content dictates which.
- **Shift the texture layer**: Flat-and-clean is one option among many. Grainy and tactile, glossy and dimensional, hand-drawn and organic, geometric and precise, photographic and immersive — the surface treatment alone can make identical structures feel like different products.

**IMPORTANT**: Match implementation complexity to the aesthetic vision. Maximalist designs need elaborate code with extensive animations and effects. Minimalist or refined designs need restraint, precision, and careful attention to spacing, typography, and subtle details. Elegance comes from executing the vision well.
