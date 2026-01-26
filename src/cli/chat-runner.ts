import inquirer from "inquirer";
import chalk from "chalk";
import ora from "ora";
import { existsSync } from "fs";
import { marked } from "marked";
import TerminalRenderer from "marked-terminal";
import {
  configExists,
  saveConfig,
  loadConfig,
} from "../core/config/manager.ts";
import { defaultConfig, type RecallConfig } from "../core/config/schema.ts";
import { VectorStore } from "../core/vector/store.ts";
import { createLLMProvider, createEmbeddingProvider } from "../llm/factory.ts";
import { assembleContext, buildSystemPrompt } from "../core/context/assembler.ts";
import { scanVault } from "../core/vault/scanner.ts";
import { parseDocument } from "../core/document/parser.ts";
import { chunkDocument } from "../core/document/chunker.ts";
import type { Message } from "../llm/types.ts";
import { logger } from "../utils/logger.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
marked.setOptions({ renderer: new TerminalRenderer() as any });

export interface ChatOptions {
  query?: string;
  stream: boolean;
}

async function runFirstTimeSetup(): Promise<RecallConfig> {
  console.log(chalk.bold.cyan("\nWelcome to Recall CLI!\n"));
  console.log(chalk.dim("It looks like this is your first time. Let's set things up.\n"));

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

  saveConfig(newConfig);
  console.log(chalk.green("\n✔ Configuration saved!\n"));

  return newConfig;
}

async function runIndexing(config: RecallConfig): Promise<{ indexed: number; chunks: number }> {
  const spinner = ora("Scanning vault...").start();

  const files = await scanVault(
    config.vault.path,
    config.vault.excludePatterns
  );

  spinner.text = `Found ${files.length} markdown files`;

  const store = new VectorStore(config.embeddings.dimensions);
  const embedder = createEmbeddingProvider(config);

  let indexed = 0;
  let totalChunks = 0;

  for (const file of files) {
    spinner.text = `Indexing: ${file.relativePath}`;

    try {
      const parsed = parseDocument(file.path);
      const chunks = chunkDocument(parsed.content);

      const docId = store.insertDocument(
        file.relativePath,
        parsed.metadata.title,
        parsed.content,
        { ...parsed.metadata } as Record<string, unknown>,
        file.modifiedAt
      );

      store.deleteDocumentChunks(docId);

      const chunkTexts = chunks.map((c) => c.content);
      const embeddings = await embedder.embedBatch(chunkTexts);

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]!;
        const embedding = embeddings[i] || null;
        store.insertChunk(
          docId,
          chunk.content,
          chunk.index,
          chunk.heading || null,
          chunk.startLine,
          chunk.endLine,
          embedding
        );
      }

      totalChunks += chunks.length;
      indexed++;
    } catch (error) {
      logger.warn(`Failed to index ${file.relativePath}: ${error}`);
    }
  }

  store.close();
  spinner.succeed(`Indexed ${indexed} documents (${totalChunks} chunks)`);

  return { indexed, chunks: totalChunks };
}

async function promptForIndexing(config: RecallConfig): Promise<void> {
  console.log(chalk.yellow("Your vault hasn't been indexed yet."));

  const { shouldIndex } = await inquirer.prompt([
    {
      type: "confirm",
      name: "shouldIndex",
      message: "Index your vault now?",
      default: true,
    },
  ]);

  if (shouldIndex) {
    console.log();
    await runIndexing(config);
    console.log();
  } else {
    console.log(chalk.dim("Continuing without index. Chat will have no context.\n"));
  }
}

async function runChatLoop(config: RecallConfig, options: ChatOptions): Promise<void> {
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
}

export async function runChat(options: ChatOptions): Promise<void> {
  try {
    let config: RecallConfig;

    // Step 1: Check if config exists, run first-time setup if not
    if (!configExists()) {
      config = await runFirstTimeSetup();
    } else {
      config = loadConfig();
    }

    // Step 2: Check if vault is indexed
    const store = new VectorStore(config.embeddings.dimensions);
    const stats = store.getStats();
    store.close();

    if (stats.documents === 0) {
      await promptForIndexing(config);
    }

    // Step 3: Run chat loop
    await runChatLoop(config, options);
  } catch (error) {
    logger.error(String(error));
    process.exit(1);
  }
}
