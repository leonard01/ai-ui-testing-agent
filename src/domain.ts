/**
 * Provisional domain contracts for the future agent platform.
 * These are subject to design review and are not execution code.
 */

export type ExpectationProvenance =
  | 'requirements'
  | 'human-confirmed'
  | 'inferred';

export type TestAction =
  | { kind: 'navigate'; url: string }
  | { kind: 'click'; target: string }
  | { kind: 'fill'; target: string; value: string }
  | {
      kind: 'assert-text';
      target: string;
      expected: string;
      provenance: ExpectationProvenance;
    };

export interface TestStep {
  id: string;
  description: string;
  action: TestAction;
}

export interface TestDefinition {
  id: string;
  title: string;
  version: number;
  steps: TestStep[];
}

export type BrowserController = 'human' | 'ai';

export interface SessionState {
  sessionId: string;
  owner: BrowserController;
  status: 'running' | 'paused' | 'stopped';
  activeStepId?: string;
}
