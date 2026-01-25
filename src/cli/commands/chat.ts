import { Command } from "commander";
import inquirer from "inquirer";
import chalk from "chalk";
import ora from "ora";
import { marked } from "marked";
import TerminalRenderer from "marked-terminal";
import { loadConfig } from "../../core/config/manager.ts";
import { VectorStore } from "../../core/vector/store.ts";
import { createLLMProvider, createEmbeddingProvider } from "../../llm/factory.ts";
import { assembleContext, buildSystemPrompt } from "../../core/context/assembler.ts";
import type { Message } from "../../llm/types.ts";
import { logger } from "../../utils/logger.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
marked.setOptions({ renderer: new TerminalRenderer() as any });

export function createChatCommand(): Command {
  return new Command("chat")
    .description("Chat with your notes using AI")
    .option("-q, --query <query>", "Single query mode (non-interactive)")
    .option("--no-stream", "Disable streaming output")
    .action(async (options: { query?: string; stream: boolean }) => {
      try {
        const config = loadConfig();
        const store = new VectorStore(config.embeddings.dimensions);
        const llm = createLLMProvider(config);
        const embedder = createEmbeddingProvider(config);

        const messages: Message[] = [];

        console.log(chalk.bold("\nRecall Chat"));
        console.log(chalk.dim("Ask questions about your notes. Type 'exit' to quit.\n"));

        const processQuery = async (query: string) => {
          const spinner = ora("Searching notes...").start();

          const queryEmbedding = await embedder.embed(query);
          const results = store.searchSimilar(
            queryEmbedding,
            config.search.topK,
            config.search.minScore
          );

          const context = assembleContext(results);
          spinner.text = "Generating response...";

          const systemPrompt = buildSystemPrompt(context);

          const chatMessages: Message[] = [
            { role: "system", content: systemPrompt },
            ...messages,
            { role: "user", content: query },
          ];

          if (options.stream) {
            spinner.stop();
            process.stdout.write(chalk.cyan("\nAssistant: "));

            let fullResponse = "";
            for await (const chunk of llm.stream(chatMessages, {
              temperature: config.llm.temperature,
              maxTokens: config.llm.maxTokens,
            })) {
              process.stdout.write(chunk.content);
              fullResponse += chunk.content;
            }
            console.log("\n");

            messages.push({ role: "user", content: query });
            messages.push({ role: "assistant", content: fullResponse });
          } else {
            const response = await llm.chat(chatMessages, {
              temperature: config.llm.temperature,
              maxTokens: config.llm.maxTokens,
            });

            spinner.stop();
            console.log(chalk.cyan("\nAssistant:"));
            console.log(marked.parse(response.content));

            messages.push({ role: "user", content: query });
            messages.push({ role: "assistant", content: response.content });
          }

          if (context.sources.length > 0) {
            console.log(chalk.dim("Sources: " + context.sources.join(", ")));
            console.log();
          }
        };

        if (options.query) {
          await processQuery(options.query);
          store.close();
          return;
        }

        while (true) {
          const { input } = await inquirer.prompt([
            {
              type: "input",
              name: "input",
              message: chalk.green("You:"),
            },
          ]);

          const query = input.trim();

          if (query.toLowerCase() === "exit" || query.toLowerCase() === "quit") {
            console.log(chalk.dim("Goodbye!"));
            break;
          }

          if (!query) {
            continue;
          }

          if (query === "/clear") {
            messages.length = 0;
            console.log(chalk.dim("Chat history cleared.\n"));
            continue;
          }

          if (query === "/sources") {
            const spinner = ora("Fetching sources...").start();
            const stats = store.getStats();
            spinner.stop();
            console.log(
              chalk.dim(
                `Indexed: ${stats.documents} documents, ${stats.chunksWithEmbeddings} chunks\n`
              )
            );
            continue;
          }

          await processQuery(query);
        }

        store.close();
      } catch (error) {
        logger.error(String(error));
        process.exit(1);
      }
    });
}
