import { Command } from "commander";
import chalk from "chalk";
import { loadConfig, configExists, getConfigPath, getDbPath } from "../../core/config/manager.ts";
import { VectorStore } from "../../core/vector/store.ts";
import { scanVault, getVaultStats } from "../../core/vault/scanner.ts";
import { existsSync, statSync } from "fs";
import { logger } from "../../utils/logger.ts";

export function createStatusCommand(): Command {
  return new Command("status")
    .description("Show indexing status and statistics")
    .action(async () => {
      console.log(chalk.bold("\nRecall CLI Status\n"));

      if (!configExists()) {
        console.log(chalk.yellow("Configuration: ") + chalk.red("Not initialized"));
        console.log(chalk.dim('\nRun "recall config init" to get started.\n'));
        return;
      }

      console.log(chalk.yellow("Configuration: ") + chalk.green("Initialized"));
      console.log(chalk.dim(`  Path: ${getConfigPath()}`));

      try {
        const config = loadConfig();

        console.log(chalk.yellow("\nVault:"));
        console.log(`  Path: ${config.vault.path}`);

        if (existsSync(config.vault.path)) {
          const files = await scanVault(
            config.vault.path,
            config.vault.excludePatterns
          );
          const stats = getVaultStats(files);

          console.log(chalk.green(`  Files: ${stats.totalFiles} markdown files`));
          if (stats.lastModified) {
            console.log(
              chalk.dim(`  Last modified: ${stats.lastModified.toLocaleString()}`)
            );
          }
        } else {
          console.log(chalk.red("  Vault path does not exist!"));
        }

        console.log(chalk.yellow("\nLLM Provider:"));
        console.log(`  Provider: ${config.llm.provider}`);
        console.log(`  Model: ${config.llm.model}`);

        console.log(chalk.yellow("\nEmbeddings:"));
        console.log(`  Provider: ${config.embeddings.provider}`);
        console.log(`  Model: ${config.embeddings.model}`);
        console.log(`  Dimensions: ${config.embeddings.dimensions}`);

        const dbPath = getDbPath();
        console.log(chalk.yellow("\nDatabase:"));
        console.log(`  Path: ${dbPath}`);

        if (existsSync(dbPath)) {
          const dbStats = statSync(dbPath);
          const sizeMB = (dbStats.size / 1024 / 1024).toFixed(2);
          console.log(chalk.dim(`  Size: ${sizeMB} MB`));

          const store = new VectorStore(config.embeddings.dimensions);
          const indexStats = store.getStats();
          store.close();

          console.log(chalk.green(`  Documents: ${indexStats.documents}`));
          console.log(chalk.green(`  Chunks: ${indexStats.chunks}`));
          console.log(
            chalk.green(`  Embedded chunks: ${indexStats.chunksWithEmbeddings}`)
          );

          if (indexStats.chunks > 0) {
            const embeddedPercent = (
              (indexStats.chunksWithEmbeddings / indexStats.chunks) *
              100
            ).toFixed(1);
            console.log(chalk.dim(`  Coverage: ${embeddedPercent}%`));
          }
        } else {
          console.log(chalk.red("  Not created yet"));
          console.log(chalk.dim('  Run "recall index" to create the database'));
        }

        console.log();
      } catch (error) {
        logger.error(String(error));
        process.exit(1);
      }
    });
}
