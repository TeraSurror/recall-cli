export class RecallError extends Error {
  constructor(
    message: string,
    public code: string
  ) {
    super(message);
    this.name = "RecallError";
  }
}

export class ConfigError extends RecallError {
  constructor(message: string) {
    super(message, "CONFIG_ERROR");
    this.name = "ConfigError";
  }
}

export class VaultError extends RecallError {
  constructor(message: string) {
    super(message, "VAULT_ERROR");
    this.name = "VaultError";
  }
}

export class LLMError extends RecallError {
  constructor(message: string) {
    super(message, "LLM_ERROR");
    this.name = "LLMError";
  }
}

export class EmbeddingError extends RecallError {
  constructor(message: string) {
    super(message, "EMBEDDING_ERROR");
    this.name = "EmbeddingError";
  }
}

export class VectorStoreError extends RecallError {
  constructor(message: string) {
    super(message, "VECTOR_STORE_ERROR");
    this.name = "VectorStoreError";
  }
}
