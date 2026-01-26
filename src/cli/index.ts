import { Command } from "commander";
import {
  createConfigCommand,
  createIndexCommand,
  createSearchCommand,
  createSummarizeCommand,
  createGenerateCommand,
  createStatusCommand,
} from "./commands/index.ts";
import { runChat } from "./chat-runner.ts";

export function createCLI(): Command {
  const program = new Command();

  program
    .name("recall")
    .description("CLI tool for interacting with Obsidian notes using AI")
    .version("1.0.0")
    .option("-q, --query <query>", "Single query mode (non-interactive)")
    .option("--no-stream", "Disable streaming output")
    .action(async (options: { query?: string; stream: boolean }) => {
      await runChat(options);
    });

  program.addCommand(createConfigCommand());
  program.addCommand(createIndexCommand());
  program.addCommand(createSearchCommand());
  program.addCommand(createSummarizeCommand());
  program.addCommand(createGenerateCommand());
  program.addCommand(createStatusCommand());

  return program;
}
