/** Ephemeral, automatic diagnostics. Never pass these records to the usage store. */
export type ResponseDiagnosticEvent = {
  repairs?: string[];
  parsed?: unknown;
  validation?: string;
  accepted?: boolean;
};
export type ResponseDiagnosticObserver = (attempt: number, event: ResponseDiagnosticEvent) => void;
export function createResponseCapture() {
  type Row = { call: number; mode: "json" | "text"; raw?: string; providerError?: string;
    rawTruncated?: boolean; errorTruncated?: boolean; repairedJSON?: string; repairedTruncated?: boolean;
    repairs?: string[]; validation?: string; accepted?: boolean };
  const rows: Row[] = [];
  const max = 128_000;
  function safe(value: string) {
    const key = process.env.GROQ_API_KEY?.trim();
    const redacted = key ? value.split(key).join("[REDACTED API KEY]") : value;
    return { value: redacted.slice(0,max), truncated: redacted.length > max };
  }
  const find = (call: number) => rows.find(row => row.call === call);
  return {
    start(call: number, mode: "json" | "text") { if (rows.length < 2) rows.push({call,mode}); },
    raw(call: number, raw: string) {
      const row = find(call); if (!row) return;
      const s = safe(raw); row.raw = s.value; row.rawTruncated = s.truncated;
    },
    providerError(call: number, raw: string) {
      const row = find(call); if (!row) return;
      const s = safe(raw); row.providerError = s.value; row.errorTruncated = s.truncated;
    },
    observe: ((call, event) => {
      const row = find(call); if (!row) return;
      if (event.repairs) row.repairs = event.repairs;
      if (event.parsed !== undefined && event.repairs?.length) {
        const s = safe(JSON.stringify(event.parsed, null, 2));
        row.repairedJSON = s.value; row.repairedTruncated = s.truncated;
      }
      if (event.validation) row.validation = safe(event.validation).value.slice(0,1000);
      if (event.accepted) row.accepted = true;
    }) as ResponseDiagnosticObserver,
    snapshot() { return rows; },
  };
}
