declare const __DEV__: boolean;

declare module "cloudflare:workers" {
  export abstract class WorkflowEntrypoint<Env = unknown, Params = unknown> {
    protected env: Env;
    constructor(context: unknown, env: Env);
    abstract run(event: { payload: Params; instanceId: string }, step: WorkflowStep): Promise<unknown>;
  }

  export interface WorkflowStep {
    do<T>(name: string, callback: () => Promise<T>): Promise<T>;
    do<T>(name: string, options: unknown, callback: () => Promise<T>): Promise<T>;
  }
}
