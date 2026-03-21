export function formatCommandFailure(input: {
  label: string;
  subject: string;
  command: string;
  exitCode: number;
  output?: string;
}): string {
  const lines = [
    `${input.label} failed for ${input.subject} with exit code ${input.exitCode}.`,
    `Command: ${input.command}`
  ];
  const output = input.output?.trim();

  if (output) {
    lines.push(`Output:\n${output}`);
  }

  return lines.join("\n");
}

export function formatErrorForCli(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  return String(error);
}
