# Recall CLI

A command-line tool for interacting with your Obsidian notes using AI. Recall indexes your vault, enables semantic search, and lets you chat with your notes using local or cloud LLM providers.

## Features

- **Semantic Search** - Find notes by meaning, not just keywords
- **AI Chat** - Have conversations with your knowledge base
- **Note Generation** - Create new notes with AI assistance
- **Summarization** - Generate summaries of notes or folders
- **Multiple LLM Providers** - Supports Ollama (local), OpenAI, and Anthropic

## Prerequisites

- [Bun](https://bun.sh/) runtime (v1.0+)
- [Ollama](https://ollama.ai/) (for local LLM and embeddings) or API keys for cloud providers

## Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/recall-cli.git
cd recall-cli

# Install dependencies
bun install

# Link globally (optional)
bun link
```

## Quick Start

```bash
# 1. Initialize configuration
recall config init

# 2. Index your vault
recall index

# 3. Start chatting with your notes
recall chat
```

## Commands

### `recall config`

Manage configuration settings.

```bash
# Initialize configuration interactively
recall config init

# Force overwrite existing config
recall config init --force

# Show current configuration
recall config show

# Show config file path
recall config path
```

### `recall index`

Index your Obsidian vault for semantic search.

```bash
# Index vault (only new/modified files)
recall index

# Re-index all files
recall index --force

# Preview what would be indexed
recall index --dry-run
```

### `recall search`

Search your notes semantically.

```bash
# Basic search
recall search "machine learning concepts"

# Limit results
recall search "project ideas" --limit 10

# Set minimum similarity score
recall search "meeting notes" --min-score 0.7
```

### `recall chat`

Interactive chat with your notes using AI.

```bash
# Start interactive chat
recall chat

# Single query mode
recall chat --query "What did I write about productivity?"

# Disable streaming output
recall chat --no-stream
```

**Chat commands:**
- Type `exit` or `quit` to end the session
- `/clear` - Clear chat history
- `/sources` - Show indexing statistics

### `recall summarize`

Generate summaries of notes or folders.

```bash
# Summarize recent notes
recall summarize

# Summarize a specific note
recall summarize "Projects/my-project.md"

# Summarize a folder
recall summarize "Daily Notes/"

# Options
recall summarize --detailed      # More comprehensive summary
recall summarize --bullets       # Format as bullet points
```

### `recall generate`

Generate new notes using AI.

```bash
# Generate a note
recall generate "A guide to effective note-taking"

# Save directly to vault
recall generate "Meeting notes template" --output "Templates/meeting.md"

# Generate without context from existing notes
recall generate "Project plan" --no-context

# Use templates
recall generate "Today's tasks" --template daily
recall generate "Team sync" --template meeting
recall generate "New feature" --template project
```

### `recall status`

Show indexing status and statistics.

```bash
recall status
```

Displays:
- Configuration status
- Vault information (path, file count)
- LLM provider settings
- Embeddings configuration
- Database statistics

## Configuration

Configuration is stored in `~/.config/recall-cli/config.json`.

### Configuration Options

```json
{
  "vault": {
    "path": "/path/to/your/obsidian/vault",
    "excludePatterns": [".obsidian/**", ".trash/**", ".git/**"]
  },
  "llm": {
    "provider": "ollama",
    "model": "llama3.2",
    "temperature": 0.7,
    "maxTokens": 2048
  },
  "embeddings": {
    "provider": "ollama",
    "model": "nomic-embed-text",
    "dimensions": 768
  },
  "search": {
    "topK": 5,
    "minScore": 0.7
  }
}
```

### LLM Providers

#### Ollama (Local)

Default provider. Requires [Ollama](https://ollama.ai/) running locally.

```bash
# Pull recommended models
ollama pull llama3.2
ollama pull nomic-embed-text
```

#### OpenAI

Set the `OPENAI_API_KEY` environment variable:

```bash
export OPENAI_API_KEY="your-api-key"
```

Recommended model: `gpt-4o-mini`

#### Anthropic

Set the `ANTHROPIC_API_KEY` environment variable:

```bash
export ANTHROPIC_API_KEY="your-api-key"
```

Recommended model: `claude-sonnet-4-20250514`

## How It Works

1. **Indexing**: Recall scans your vault, parses markdown files, and splits them into chunks
2. **Embeddings**: Each chunk is converted to a vector embedding using your configured provider
3. **Storage**: Embeddings are stored in a local SQLite database with vector search capabilities
4. **Search**: Queries are embedded and matched against stored chunks using cosine similarity
5. **Context Assembly**: Relevant chunks are assembled into context for LLM conversations

## Development

```bash
# Run in development mode with watch
bun run dev

# Type checking
bun run typecheck

# Run directly
bun run src/index.ts
```

## License

MIT License - see [LICENSE](LICENSE) for details.
