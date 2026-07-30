export interface GenerateObjectRequest {
  model: string;
  schemaName: string;
  jsonSchema: Record<string, unknown>;
  system: string;
  sourcePacket: string;
  maxOutputTokens: number;
}

export interface ModelProvider {
  embed(
    texts: readonly string[],
  ): Promise<readonly (readonly number[])[]>;
  generateObject(input: GenerateObjectRequest): Promise<unknown>;
}

export interface ModelUsage {
  operation: "embedding" | "generation";
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}
