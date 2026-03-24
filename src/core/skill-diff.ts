import fs from "fs-extra";
import path from "node:path";

export interface SkillDiffLine {
  type: "context" | "added" | "removed" | "spacer";
  oldLineNumber: number | null;
  newLineNumber: number | null;
  text: string;
  omittedLineCount?: number;
}

export interface SkillDiffFile {
  path: string;
  status: "added" | "removed" | "modified";
  addedLineCount: number;
  removedLineCount: number;
  lines: SkillDiffLine[];
}

export interface SkillDiff {
  compareTarget: "original" | "previous";
  label: string;
  basePath: string;
  currentPath: string;
  changedFileCount: number;
  files: SkillDiffFile[];
}

function listRelativeFilesSync(rootPath: string): string[] {
  if (!fs.existsSync(rootPath)) {
    return [];
  }

  const files: string[] = [];

  function walk(currentPath: string): void {
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const absolutePath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }

      files.push(path.relative(rootPath, absolutePath).split(path.sep).join("/"));
    }
  }

  walk(rootPath);
  return files;
}

function normalizeFileContent(value: string): string {
  return value.replaceAll("\r\n", "\n");
}

function splitFileLines(value: string): string[] {
  if (value.length === 0) {
    return [];
  }

  const normalized = normalizeFileContent(value);
  const lines = normalized.split("\n");
  if (normalized.endsWith("\n")) {
    lines.pop();
  }

  return lines;
}

function buildRawDiffLines(
  beforeLines: string[],
  afterLines: string[]
): SkillDiffLine[] {
  const lcs = Array.from({ length: beforeLines.length + 1 }, () =>
    Array<number>(afterLines.length + 1).fill(0)
  );

  for (let beforeIndex = beforeLines.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
    for (let afterIndex = afterLines.length - 1; afterIndex >= 0; afterIndex -= 1) {
      lcs[beforeIndex]![afterIndex] =
        beforeLines[beforeIndex] === afterLines[afterIndex]
          ? (lcs[beforeIndex + 1]?.[afterIndex + 1] ?? 0) + 1
          : Math.max(
              lcs[beforeIndex + 1]?.[afterIndex] ?? 0,
              lcs[beforeIndex]?.[afterIndex + 1] ?? 0
            );
    }
  }

  const lines: SkillDiffLine[] = [];
  let beforeIndex = 0;
  let afterIndex = 0;
  let oldLineNumber = 1;
  let newLineNumber = 1;

  while (beforeIndex < beforeLines.length && afterIndex < afterLines.length) {
    if (beforeLines[beforeIndex] === afterLines[afterIndex]) {
      lines.push({
        type: "context",
        oldLineNumber,
        newLineNumber,
        text: beforeLines[beforeIndex]
      });
      beforeIndex += 1;
      afterIndex += 1;
      oldLineNumber += 1;
      newLineNumber += 1;
      continue;
    }

    if ((lcs[beforeIndex + 1]?.[afterIndex] ?? 0) >= (lcs[beforeIndex]?.[afterIndex + 1] ?? 0)) {
      lines.push({
        type: "removed",
        oldLineNumber,
        newLineNumber: null,
        text: beforeLines[beforeIndex]
      });
      beforeIndex += 1;
      oldLineNumber += 1;
      continue;
    }

    lines.push({
      type: "added",
      oldLineNumber: null,
      newLineNumber,
      text: afterLines[afterIndex]
    });
    afterIndex += 1;
    newLineNumber += 1;
  }

  while (beforeIndex < beforeLines.length) {
    lines.push({
      type: "removed",
      oldLineNumber,
      newLineNumber: null,
      text: beforeLines[beforeIndex]
    });
    beforeIndex += 1;
    oldLineNumber += 1;
  }

  while (afterIndex < afterLines.length) {
    lines.push({
      type: "added",
      oldLineNumber: null,
      newLineNumber,
      text: afterLines[afterIndex]
    });
    afterIndex += 1;
    newLineNumber += 1;
  }

  return lines;
}

function compactDiffLines(
  lines: SkillDiffLine[],
  contextRadius = 3
): SkillDiffLine[] {
  const changedIndexes = lines.flatMap((line, index) =>
    line.type === "added" || line.type === "removed" ? [index] : []
  );

  if (changedIndexes.length === 0) {
    return [];
  }

  const ranges: Array<{ start: number; end: number }> = [];
  for (const index of changedIndexes) {
    const start = Math.max(0, index - contextRadius);
    const end = Math.min(lines.length - 1, index + contextRadius);
    const previousRange = ranges[ranges.length - 1];

    if (previousRange && start <= previousRange.end + 1) {
      previousRange.end = Math.max(previousRange.end, end);
      continue;
    }

    ranges.push({ start, end });
  }

  const compacted: SkillDiffLine[] = [];
  let cursor = 0;

  for (const range of ranges) {
    if (range.start > cursor) {
      compacted.push({
        type: "spacer",
        oldLineNumber: null,
        newLineNumber: null,
        text: "",
        omittedLineCount: range.start - cursor
      });
    }

    compacted.push(...lines.slice(range.start, range.end + 1));
    cursor = range.end + 1;
  }

  if (cursor < lines.length) {
    compacted.push({
      type: "spacer",
      oldLineNumber: null,
      newLineNumber: null,
      text: "",
      omittedLineCount: lines.length - cursor
    });
  }

  return compacted;
}

export function buildSkillDiffFromDirectories(input: {
  basePath: string;
  baseLabel: string;
  currentPath: string;
  currentLabel: string;
  compareTarget: "original" | "previous";
  label: string;
}): SkillDiff | null {
  if (!fs.existsSync(input.basePath) || !fs.existsSync(input.currentPath)) {
    return null;
  }

  const filePaths = [
    ...new Set([
      ...listRelativeFilesSync(input.basePath),
      ...listRelativeFilesSync(input.currentPath)
    ])
  ].sort((left, right) => left.localeCompare(right));
  const files: SkillDiffFile[] = [];

  for (const relativePath of filePaths) {
    const baseFilePath = path.join(input.basePath, relativePath);
    const currentFilePath = path.join(input.currentPath, relativePath);
    const hasBaseFile = fs.existsSync(baseFilePath);
    const hasCurrentFile = fs.existsSync(currentFilePath);

    if (!hasBaseFile && !hasCurrentFile) {
      continue;
    }

    const baseContent = hasBaseFile
      ? normalizeFileContent(fs.readFileSync(baseFilePath, "utf8"))
      : "";
    const currentContent = hasCurrentFile
      ? normalizeFileContent(fs.readFileSync(currentFilePath, "utf8"))
      : "";

    if (baseContent === currentContent) {
      continue;
    }

    const rawLines = buildRawDiffLines(
      splitFileLines(baseContent),
      splitFileLines(currentContent)
    );

    files.push({
      path: relativePath,
      status:
        !hasBaseFile ? "added" : !hasCurrentFile ? "removed" : "modified",
      addedLineCount: rawLines.filter((line) => line.type === "added").length,
      removedLineCount: rawLines.filter((line) => line.type === "removed").length,
      lines: compactDiffLines(rawLines)
    });
  }

  if (files.length === 0) {
    return null;
  }

  return {
    compareTarget: input.compareTarget,
    label: input.label,
    basePath: input.baseLabel,
    currentPath: input.currentLabel,
    changedFileCount: files.length,
    files
  };
}

export function formatSkillDiffForText(skillDiff: SkillDiff): string {
  const sections = [
    "Skill diff",
    `Compared ${skillDiff.basePath} with ${skillDiff.currentPath}.`,
    `${skillDiff.changedFileCount} changed file${skillDiff.changedFileCount === 1 ? "" : "s"}.`,
    ""
  ];

  for (const file of skillDiff.files) {
    sections.push(
      `File: ${file.path} (${file.status}, +${file.addedLineCount}/-${file.removedLineCount})`
    );

    for (const line of file.lines) {
      if (line.type === "spacer") {
        sections.push(`... ${line.omittedLineCount ?? 0} unchanged line(s) omitted ...`);
        continue;
      }

      const sign =
        line.type === "added" ? "+" : line.type === "removed" ? "-" : " ";
      const oldLineNumber =
        line.oldLineNumber == null ? " " : String(line.oldLineNumber);
      const newLineNumber =
        line.newLineNumber == null ? " " : String(line.newLineNumber);
      sections.push(`${oldLineNumber.padStart(4)} ${newLineNumber.padStart(4)} ${sign} ${line.text}`);
    }

    sections.push("");
  }

  return sections.join("\n").trim();
}
