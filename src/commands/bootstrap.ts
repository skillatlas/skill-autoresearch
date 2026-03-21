import fs from "fs-extra";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";

import { resolveWorkspaceRoot } from "./run.js";

const BOOTSTRAP_FILENAMES = [
  "GENERATION.md",
  "RUBRIC.md",
  "INSTRUCTIONS.md"
] as const;

export interface BootstrapResult {
  workspaceRoot: string;
  copied: string[];
  skipped: string[];
}

export function findPackageRoot(moduleUrl: string = import.meta.url): string {
  let currentPath = path.dirname(fileURLToPath(moduleUrl));

  while (true) {
    if (fs.existsSync(path.join(currentPath, "package.json"))) {
      return currentPath;
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      throw new Error("Unable to locate package root for bootstrap templates.");
    }

    currentPath = parentPath;
  }
}

async function copyTemplateIfMissing(
  sourcePath: string,
  destinationPath: string
): Promise<boolean> {
  if (!(await fs.pathExists(sourcePath))) {
    throw new Error(`Missing bootstrap template: ${sourcePath}`);
  }

  if (await fs.pathExists(destinationPath)) {
    return false;
  }

  await fs.copy(sourcePath, destinationPath);
  return true;
}

export async function bootstrapWorkspace(
  workspaceArg: string | undefined,
  options?: {
    invocationDirectory?: string;
    packageRoot?: string;
  }
): Promise<BootstrapResult> {
  const invocationDirectory = options?.invocationDirectory ?? process.cwd();
  const packageRoot = options?.packageRoot ?? findPackageRoot();
  const workspaceRoot = resolveWorkspaceRoot(workspaceArg, invocationDirectory);
  const copied: string[] = [];
  const skipped: string[] = [];

  await fs.ensureDir(workspaceRoot);

  const skillsCopied = await copyTemplateIfMissing(
    path.join(packageRoot, "skills"),
    path.join(workspaceRoot, "skills")
  );

  if (skillsCopied) {
    copied.push("skills/");
  } else {
    skipped.push("skills/");
  }

  for (const filename of BOOTSTRAP_FILENAMES) {
    const wasCopied = await copyTemplateIfMissing(
      path.join(packageRoot, filename),
      path.join(workspaceRoot, filename)
    );

    if (wasCopied) {
      copied.push(filename);
    } else {
      skipped.push(filename);
    }
  }

  return {
    workspaceRoot,
    copied,
    skipped
  };
}

export async function runBootstrapCommand(
  workspaceArg: string | undefined
): Promise<void> {
  const result = await bootstrapWorkspace(workspaceArg);

  for (const relativePath of result.copied) {
    console.log(`Copied ${relativePath}`);
  }

  for (const relativePath of result.skipped) {
    console.log(`Skipped existing ${relativePath}`);
  }

  console.log(`Workspace ready at ${result.workspaceRoot}`);
}

export function buildBootstrapCommand(): Command {
  return new Command("bootstrap")
    .description("Copy starter workspace files into the target directory.")
    .argument("[workspace]", "Workspace root", ".")
    .action((workspaceArg: string | undefined) => runBootstrapCommand(workspaceArg));
}
