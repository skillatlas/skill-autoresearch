import fs from "fs-extra";
import os from "node:os";
import path from "node:path";

import { loadInstructions } from "./instructions.js";
import { Logger } from "./logger.js";
import { loadGenerations } from "./generation.js";
import { ScoringMode } from "../types/state.js";
import {
  GenerationProvider,
  GenerationSpec
} from "../types/generation.js";
import { InstructionsSpec } from "../types/instructions.js";

export interface WorkspacePaths {
  root: string;
  instructionsPath: string;
  generationPath: string;
  rubricPath: string;
  envPath: string;
  skillsDir: string;
  stepsDir: string;
  archiveDir: string;
  skillsOriginalDir: string;
  skillsPreviousDir: string;
  runtimeDir: string;
  logsDir: string;
  statePath: string;
}

export interface ExecutionSandbox {
  containerRoot: string;
  targetPath: string;
  persistArtifacts(): Promise<void>;
  cleanup(): Promise<void>;
}

export interface MutationSandbox extends ExecutionSandbox {
  applyChanges(): Promise<void>;
}

function normalizeRelative(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

export class WorkspaceManager {
  public readonly root: string;
  public readonly paths: WorkspacePaths;

  public constructor(root: string, private readonly logger: Logger) {
    this.root = path.resolve(root);
    this.paths = {
      root: this.root,
      instructionsPath: path.join(this.root, "INSTRUCTIONS.md"),
      generationPath: path.join(this.root, "GENERATION.md"),
      rubricPath: path.join(this.root, "RUBRIC.md"),
      envPath: path.join(this.root, ".env"),
      skillsDir: path.join(this.root, "skills"),
      stepsDir: path.join(this.root, "steps"),
      archiveDir: path.join(this.root, "archive"),
      skillsOriginalDir: path.join(this.root, "skills-original"),
      skillsPreviousDir: path.join(this.root, "skills-previous"),
      runtimeDir: path.join(this.root, ".skill-autoresearch"),
      logsDir: path.join(this.root, ".skill-autoresearch", "logs"),
      statePath: path.join(this.root, ".skill-autoresearch", "state.json")
    };
  }

  public relativeToRoot(targetPath: string): string {
    return normalizeRelative(path.relative(this.root, targetPath));
  }

  public resolveWorkspacePath(relativePath: string): string {
    return path.resolve(this.root, relativePath);
  }

  public async validateSourceInputs(
    options: { scoringMode: ScoringMode }
  ): Promise<void> {
    await this.ensureRequiredFile(this.paths.instructionsPath);
    await this.loadGenerationSpecs();
    if (options.scoringMode === "rubric") {
      await this.ensureRequiredFile(this.paths.rubricPath);
    }
    await this.ensureRequiredDirectory(this.paths.skillsDir);
    await this.ensureManagedDirectory(this.paths.stepsDir);
    await this.ensureManagedDirectory(this.paths.archiveDir);
    await this.ensureSkillFolders();
  }

  public async prepareRuntimeDirs(): Promise<void> {
    await fs.ensureDir(this.paths.runtimeDir);
    await fs.ensureDir(this.paths.logsDir);
  }

  public async createGenerationSandbox(targetPath: string): Promise<ExecutionSandbox> {
    const sandboxRoot = await this.createTempSandboxRoot("generation-");
    const sandboxTargetPath = path.join(sandboxRoot, "artifact");
    const sandboxSkillsPath = path.join(sandboxTargetPath, "skills");
    await fs.ensureDir(sandboxTargetPath);
    await fs.copy(this.paths.skillsDir, sandboxSkillsPath);
    await this.createSandboxSkillLinks(sandboxTargetPath, sandboxSkillsPath);

    return {
      containerRoot: sandboxTargetPath,
      targetPath: sandboxTargetPath,
      persistArtifacts: async () => {
        await this.cleanupSandboxAgentLinks(sandboxTargetPath);
        await this.replaceDirectoryFromSource(sandboxTargetPath, targetPath);
      },
      cleanup: async () => {
        await fs.remove(sandboxRoot);
      }
    };
  }

  public async createMutationSandbox(stepIndex: number): Promise<MutationSandbox> {
    const sandboxRoot = await this.createTempSandboxRoot(
      `mutation-step-${stepIndex}-`
    );
    const sandboxSkillsPath = path.join(sandboxRoot, "skills");

    await fs.ensureDir(sandboxRoot);
    await fs.copy(this.paths.skillsDir, sandboxSkillsPath);
    await this.createSandboxSkillLinks(sandboxRoot, sandboxSkillsPath);

    return {
      containerRoot: sandboxRoot,
      targetPath: sandboxSkillsPath,
      persistArtifacts: async () => {},
      applyChanges: async () => {
        await this.replaceDirectoryFromSource(sandboxSkillsPath, this.paths.skillsDir);
      },
      cleanup: async () => {
        await fs.remove(sandboxRoot);
      }
    };
  }

  public async archiveExistingSteps(
    runId: string,
    options?: { dryRun?: boolean }
  ): Promise<string> {
    const dryRun = options?.dryRun ?? false;
    const archiveTarget = path.join(this.paths.archiveDir, runId);
    const relativeArchiveTarget = this.relativeToRoot(archiveTarget);
    const entries = await fs.readdir(this.paths.stepsDir);

    if (entries.length === 0) {
      return relativeArchiveTarget;
    }

    if (dryRun) {
      this.logger.info(
        `[dry-run] Would archive ${entries.length} step entr${entries.length === 1 ? "y" : "ies"} to ${relativeArchiveTarget}`
      );
      return relativeArchiveTarget;
    }

    await fs.ensureDir(archiveTarget);
    for (const entry of entries) {
      await fs.move(
        path.join(this.paths.stepsDir, entry),
        path.join(archiveTarget, entry),
        { overwrite: true }
      );
    }

    return relativeArchiveTarget;
  }

  public async snapshotSkills(kind: "original" | "previous"): Promise<void> {
    const destination =
      kind === "original"
        ? this.paths.skillsOriginalDir
        : this.paths.skillsPreviousDir;

    await this.replaceDirectoryFromSource(this.paths.skillsDir, destination);
  }

  public async restoreSkillsFromPrevious(): Promise<void> {
    await this.replaceDirectoryFromSource(
      this.paths.skillsPreviousDir,
      this.paths.skillsDir
    );
  }

  public async resetDirectory(targetPath: string): Promise<void> {
    await fs.emptyDir(targetPath);
  }

  public async ensureDirectory(targetPath: string): Promise<void> {
    await fs.ensureDir(targetPath);
  }

  public async assertDirectoryContainsFiles(
    targetPath: string,
    label: string,
    options?: { ignoredTopLevelEntries?: string[] }
  ): Promise<void> {
    if (await this.directoryContainsFiles(targetPath, options)) {
      return;
    }

    throw new Error(
      `${label} did not create any files in ${this.relativeToRoot(targetPath)}.`
    );
  }

  public async loadGenerationSpec(options?: {
    providerOverride?: GenerationProvider;
  }): Promise<GenerationSpec> {
    const generations = await this.loadGenerationSpecs(options);
    return generations[0]!;
  }

  public async loadInstructionsSpec(options?: {
    providerOverride?: GenerationProvider;
  }): Promise<InstructionsSpec> {
    return loadInstructions(this.paths.instructionsPath, options);
  }

  public async loadGenerationSpecs(options?: {
    providerOverride?: GenerationProvider;
  }): Promise<GenerationSpec[]> {
    return loadGenerations(this.root, options);
  }

  private async createSandboxSkillLinks(
    rootPath: string,
    sandboxSkillsPath: string
  ): Promise<void> {
    const linkPaths = [
      path.join(rootPath, ".claude", "skills"),
      path.join(rootPath, ".agents", "skills")
    ];

    for (const linkPath of linkPaths) {
      const expectedTarget = path.relative(path.dirname(linkPath), sandboxSkillsPath);
      await fs.ensureDir(path.dirname(linkPath));
      await fs.remove(linkPath);
      await fs.symlink(expectedTarget, linkPath, "dir");
    }
  }

  private async replaceDirectoryFromSource(
    sourcePath: string,
    destinationPath: string
  ): Promise<void> {
    const tempPath = path.join(
      this.paths.runtimeDir,
      `.tmp-${path.basename(destinationPath)}-${Date.now()}-${Math.random()
        .toString(16)
        .slice(2)}`
    );

    await fs.remove(tempPath);
    await fs.copy(sourcePath, tempPath);
    await fs.move(tempPath, destinationPath, { overwrite: true });
  }

  private async createTempSandboxRoot(prefix: string): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), `skill-autoresearch-${prefix}`));
  }

  private async cleanupSandboxAgentLinks(rootPath: string): Promise<void> {
    await fs.remove(path.join(rootPath, ".claude"));
    await fs.remove(path.join(rootPath, ".agents"));
  }

  private async ensureRequiredFile(filePath: string): Promise<void> {
    const exists = await fs.pathExists(filePath);
    if (!exists) {
      throw new Error(`Missing required file: ${this.relativeToRoot(filePath)}`);
    }

    const stats = await fs.stat(filePath);
    if (!stats.isFile()) {
      throw new Error(`Expected file: ${this.relativeToRoot(filePath)}`);
    }
  }

  private async ensureRequiredDirectory(directoryPath: string): Promise<void> {
    const exists = await fs.pathExists(directoryPath);
    if (!exists) {
      throw new Error(
        `Missing required directory: ${this.relativeToRoot(directoryPath)}`
      );
    }

    const stats = await fs.stat(directoryPath);
    if (!stats.isDirectory()) {
      throw new Error(`Expected directory: ${this.relativeToRoot(directoryPath)}`);
    }
  }

  private async ensureManagedDirectory(directoryPath: string): Promise<void> {
    const exists = await fs.pathExists(directoryPath);
    if (!exists) {
      await fs.ensureDir(directoryPath);
      return;
    }

    const stats = await fs.stat(directoryPath);
    if (!stats.isDirectory()) {
      throw new Error(`Expected directory: ${this.relativeToRoot(directoryPath)}`);
    }
  }

  private async ensureSkillFolders(): Promise<void> {
    const entries = await fs.readdir(this.paths.skillsDir);
    const skillDirectories: string[] = [];

    for (const entry of entries) {
      const entryPath = path.join(this.paths.skillsDir, entry);
      const stats = await fs.stat(entryPath);
      if (stats.isDirectory()) {
        skillDirectories.push(entryPath);
      }
    }

    if (skillDirectories.length === 0) {
      throw new Error("Expected at least one skill folder inside skills/.");
    }

    for (const skillDirectory of skillDirectories) {
      const skillPath = path.join(skillDirectory, "SKILL.md");
      const hasSkillFile = await fs.pathExists(skillPath);
      if (!hasSkillFile) {
        throw new Error(
          `Missing SKILL.md in skill folder ${this.relativeToRoot(skillDirectory)}.`
        );
      }
    }
  }

  private async directoryContainsFiles(
    targetPath: string,
    options?: { ignoredTopLevelEntries?: string[] },
    depth = 0
  ): Promise<boolean> {
    if (!(await fs.pathExists(targetPath))) {
      return false;
    }

    const entries = await fs.readdir(targetPath);
    for (const entry of entries) {
      if (depth === 0 && options?.ignoredTopLevelEntries?.includes(entry)) {
        continue;
      }

      const entryPath = path.join(targetPath, entry);
      const stats = await fs.stat(entryPath);
      if (stats.isFile()) {
        return true;
      }

      if (
        stats.isDirectory() &&
        (await this.directoryContainsFiles(entryPath, options, depth + 1))
      ) {
        return true;
      }
    }

    return false;
  }
}
