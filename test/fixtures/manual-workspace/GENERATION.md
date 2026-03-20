Generate the current artifact set.

Read `skills/demo/SKILL.md`, extract the integer from `version=<n>`, and write a single file named `index.html` in the current target directory.

Requirements for `index.html`:
- It must exist directly inside the target directory, not in a subfolder.
- Its entire contents must be exactly `score=<n>` followed by a trailing newline.
- Do not create any other files.
