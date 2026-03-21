#!/usr/bin/env node
import { Command } from "commander";

import { buildBootstrapCommand } from "./commands/bootstrap.js";
import { buildRunCommand } from "./commands/run.js";
import { formatErrorForCli } from "./core/error-format.js";

const program = new Command();

program
  .name("skill-autoresearch")
  .description("Iteratively improve skill folders with generation and rubric scoring.")
  .addCommand(buildBootstrapCommand())
  .addCommand(buildRunCommand());

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(formatErrorForCli(error));
  process.exitCode = 1;
});
