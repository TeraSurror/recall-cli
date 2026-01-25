import { Command } from "commander";
import {
  createConfigCommand,
  createIndexCommand,
  createSearchCommand,
  createChatCommand,
  createSummarizeCommand,
  createGenerateCommand,
  createStatusCommand,
} from "./commands/index.ts";

export function createCLI(): Command {
  const program = new Command();

  program
    .name("recall")
    .description("CLI tool for interacting with Obsidian notes using AI")
    .version("1.0.0");

  program.addCommand(createConfigCommand());
  program.addCommand(createIndexCommand());
  program.addCommand(createSearchCommand());
  program.addCommand(createChatCommand());
  program.addCommand(createSummarizeCommand());
  program.addCommand(createGenerateCommand());
  program.addCommand(createStatusCommand());

  return program;
}
