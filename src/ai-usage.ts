import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
export interface UsageAttempt {
  provider: "groqcloud";
  model: string;
  startedAt: string;
  durationMs: number;
  status: string;
  httpStatus?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  completionBudget: number;
  estimatedInputTokens?: number;
  estimator?: string;
  systemTokens?: number;
  promptTokens?: number;
  providerRequestedTokens?: number;
  providerTokenLimit?: number;
  providerUsedTokens?: number;
  retryAfter?: string;
  systemCharacters: number;
  promptCharacters: number;
  remainingTokens?: number;
  resetTokens?: string;
  transportAttempt: number;
  finishReason?: string;
  reasoningTokens?: number;
  responseMode?: "json" | "text";
  reasoningEffort?: "low" | "medium" | "high";
  responsePolicy?: "hybrid" | "json" | "text";
}
export interface UsageRecord extends UsageAttempt {
  id: string;
  operationId: string;
  operation: "generate" | "reinterpret";
  modelCall: number;
}
export function readTokenUsage(value: unknown) {
  const usage = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const number = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
  const inputTokens = number(usage.prompt_tokens);
  const outputTokens = number(usage.completion_tokens);
  const totalTokens = number(usage.total_tokens) ?? (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined);
  return {inputTokens, outputTokens, totalTokens};
}
export function summarizeUsage(records: UsageRecord[]) {
  const known = records.filter(r => r.totalTokens !== undefined);
  return {
    requests: records.length, knownRequests: known.length,
    totalTokens: known.reduce((sum,r)=>sum+r.totalTokens!,0),
    inputTokens: records.reduce((sum,r)=>sum+(r.inputTokens??0),0),
    outputTokens: records.reduce((sum,r)=>sum+(r.outputTokens??0),0),
    unknownRequests: records.length-known.length,
    rateLimits: records.filter(r=>r.httpStatus===429).length,
  };
}
export type ExperimentOutcome = "correct" | "incorrect" | "unreviewed";
export interface OperationResult {
  operationId: string;
  validation?: "accepted" | "rejected";
  assessment?: ExperimentOutcome;
}
export function createUsageStore(directory: string) {
  const file = join(directory,"requests.jsonl");
  const resultFile = join(directory,"operation-results.jsonl");
  let pending: Promise<void> = Promise.resolve();
  async function readLines<T>(path: string): Promise<T[]> {
    await pending;
    let raw: string;
    try { raw=await readFile(path,"utf8"); }
    catch(error) { if ((error as NodeJS.ErrnoException).code==="ENOENT") return []; throw error; }
    return raw.split("\n").filter(Boolean).flatMap(line=>{
      try { return [JSON.parse(line) as T]; } catch { return []; }
    });
  }
  return {
    async recordResult(result: OperationResult) {
      // Store only explicit scalar metadata, never response content or test instructions.
      const safe: OperationResult = {operationId:result.operationId,validation:result.validation,assessment:result.assessment};
      const write=pending.then(async()=>{
        await mkdir(directory,{recursive:true});
        await appendFile(resultFile,JSON.stringify(safe)+"\n",{encoding:"utf8",mode:0o600});
      });
      pending=write.catch(()=>{});
      await write;
    },
    async results(): Promise<OperationResult[]> {
      const merged=new Map<string,OperationResult>();
      for(const row of await readLines<OperationResult>(resultFile)) {
        if (!row || typeof row.operationId!=="string") continue;
        merged.set(row.operationId,{...merged.get(row.operationId),...row});
      }
      return [...merged.values()];
    },
    async record(operationId: string, operation: UsageRecord["operation"], modelCall: number, attempt: UsageAttempt) {
      const record: UsageRecord = {...attempt,id:randomUUID(),operationId,operation,modelCall};
      const write = pending.then(async()=>{
        await mkdir(directory,{recursive:true});
        await appendFile(file,JSON.stringify(record)+"\n",{encoding:"utf8",mode:0o600});
      });
      pending=write.catch(()=>{});
      await write;
      return record;
    },
    async list(): Promise<UsageRecord[]> {
      await pending;
      let raw: string;
      try { raw=await readFile(file,"utf8"); }
      catch(error) { if ((error as NodeJS.ErrnoException).code==="ENOENT") return []; throw error; }
      return raw.split("\n").filter(Boolean).flatMap(line=>{
        try { const row=JSON.parse(line) as UsageRecord; return row.id && row.operationId ? [row] : []; }
        catch { return []; }
      });
    }
  };
}
