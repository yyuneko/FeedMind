export interface WorkflowStep {
  do<T>(name: string, callback: () => Promise<T>): Promise<T>;
  do<T>(name: string, options: unknown, callback: () => Promise<T>): Promise<T>;
}

export class WorkflowEntrypoint<Env = unknown, Params = unknown> {
  protected env: Env;

  constructor(_context: unknown, env: Env) {
    this.env = env;
  }

  async run(_event: { payload: Params; instanceId: string }, _step: WorkflowStep): Promise<unknown> {
    throw new Error("WorkflowEntrypoint.run must be implemented");
  }
}
