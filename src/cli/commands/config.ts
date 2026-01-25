import { Command } from "commander";
import inquirer from "inquirer";
import chalk from "chalk";
import ora from "ora";
import { existsSync } from "fs";
import {
  configExists,
  saveConfig,
  loadConfig,
  getConfigPath,
} from "../../core/config/manager.ts";
import { defaultConfig, type RecallConfig } from "../../core/config/schema.ts";
import { logger } from "../../utils/logger.ts";

export function createConfigCommand(): Command {
  const config = new Command("config").description("Manage configuration");

  config
    .command("init")
    .description("Initialize recall-cli configuration")
    .option("-f, --force", "Overwrite existing configuration")
    .action(async (options: { force?: boolean }) => {
      if (configExists() && !options.force) {
        logger.warn("Configuration already exists.");
        const { overwrite } = await inquirer.prompt([
          {
            type: "confirm",
            name: "overwrite",
            message: "Overwrite existing configuration?",
            default: false,
          },
        ]);
        if (!overwrite) {
          logger.info("Configuration unchanged.");
          return;
        }
      }

      const answers = await inquirer.prompt([
        {
          type: "input",
          name: "vaultPath",
          message: "Path to your Obsidian vault:",
          validate: (input: string) => {
            if (!input.trim()) return "Vault path is required";
            const path = input.startsWith("~")
              ? input.replace("~", process.env.HOME || "")
              : input;
            if (!existsSync(path)) return "Path does not exist";
            return true;
          },
        },
        {
          type: "list",
          name: "llmProvider",
          message: "Select LLM provider:",
          choices: [
            { name: "Ollama (local)", value: "ollama" },
            { name: "OpenAI", value: "openai" },
            { name: "Anthropic (Claude)", value: "anthropic" },
          ],
          default: "ollama",
        },
        {
          type: "input",
          name: "llmModel",
          message: "LLM model name:",
          default: (answers: { llmProvider: string }) => {
            switch (answers.llmProvider) {
              case "ollama":
                return "llama3.2";
              case "openai":
                return "gpt-4o-mini";
              case "anthropic":
                return "claude-sonnet-4-20250514";
              default:
                return "llama3.2";
            }
          },
        },
      ]);

      const vaultPath = answers.vaultPath.startsWith("~")
        ? answers.vaultPath.replace("~", process.env.HOME || "")
        : answers.vaultPath;

      const newConfig: RecallConfig = {
        ...defaultConfig,
        vault: {
          ...defaultConfig.vault,
          path: vaultPath,
        },
        llm: {
          ...defaultConfig.llm,
          provider: answers.llmProvider,
          model: answers.llmModel,
        },
      };

      const spinner = ora("Saving configuration...").start();

      try {
        saveConfig(newConfig);
        spinner.succeed("Configuration saved!");
        logger.info(`Config file: ${getConfigPath()}`);
        logger.info(`Vault path: ${vaultPath}`);
        logger.info(`LLM provider: ${answers.llmProvider}`);
        console.log(
          chalk.dim('\nRun "recall index" to index your vault.')
        );
      } catch (error) {
        spinner.fail("Failed to save configuration");
        logger.error(String(error));
        process.exit(1);
      }
    });

  config
    .command("show")
    .description("Show current configuration")
    .action(() => {
      try {
        const cfg = loadConfig();
        console.log(chalk.bold("\nCurrent Configuration:\n"));
        console.log(JSON.stringify(cfg, null, 2));
      } catch (error) {
        logger.error(String(error));
        process.exit(1);
      }
    });

  config
    .command("path")
    .description("Show configuration file path")
    .action(() => {
      console.log(getConfigPath());
    });

  return config;
}
