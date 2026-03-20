#!/usr/bin/env node
import { Command } from "commander";

import { buildRunCommand } from "./commands/run.js";

const program = new Command();

program
  .name("skill-autoresearch")
  .description("Iteratively improve skill folders with generation and rubric scoring.")
  .addCommand(buildRunCommand());

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
