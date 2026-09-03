declare module "cloudflare:workers" {
  export abstract class WorkflowEntrypoint<Env = unknown, Params = unknown> {
    protected env: Env;
    protected ctx: unknown;
    abstract run(event: { payload: Params; instanceId: string }, step: WorkflowStep): Promise<unknown>;
  }
  export interface WorkflowStep {
    do<T>(name: string, callback: () => Promise<T>): Promise<T>;
    do<T>(name: string, config: Record<string, unknown>, callback: () => Promise<T>): Promise<T>;
  }
}

declare const __DEV__: boolean;
