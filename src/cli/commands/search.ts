import { Command } from "commander";
import ora from "ora";
import chalk from "chalk";
import { loadConfig } from "../../core/config/manager.ts";
import { VectorStore } from "../../core/vector/store.ts";
import { createEmbeddingProvider } from "../../llm/factory.ts";
import { logger } from "../../utils/logger.ts";

export function createSearchCommand(): Command {
  return new Command("search")
    .description("Search your notes semantically")
    .argument("<query>", "Search query")
    .option("-n, --limit <number>", "Number of results", "5")
    .option("-s, --min-score <number>", "Minimum similarity score", "0.5")
    .action(
      async (
        query: string,
        options: { limit: string; minScore: string }
      ) => {
        try {
          const config = loadConfig();
          const spinner = ora("Searching...").start();

          const store = new VectorStore(config.embeddings.dimensions);
          const embedder = createEmbeddingProvider(config);

          const queryEmbedding = await embedder.embed(query);
          const results = store.searchSimilar(
            queryEmbedding,
            parseInt(options.limit),
            parseFloat(options.minScore)
          );

          store.close();

          if (results.length === 0) {
            spinner.info("No matching results found");
            return;
          }

          spinner.succeed(`Found ${results.length} results\n`);

          for (const result of results) {
            const scoreColor =
              result.score > 0.8
                ? chalk.green
                : result.score > 0.6
                ? chalk.yellow
                : chalk.red;

            console.log(
              chalk.bold(result.title) +
                " " +
                scoreColor(`(${(result.score * 100).toFixed(1)}%)`)
            );
            console.log(chalk.dim(result.path));

            if (result.heading) {
              console.log(chalk.cyan(`  > ${result.heading}`));
            }

            const preview = result.content.slice(0, 200).replace(/\n/g, " ");
            console.log(
              chalk.dim(
                preview.length < result.content.length
                  ? preview + "..."
                  : preview
              )
            );
            console.log();
          }
        } catch (error) {
          logger.error(String(error));
          process.exit(1);
        }
      }
    );
}
