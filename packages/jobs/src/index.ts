export interface JobHandler<TInput> {
  run(input: TInput): Promise<void>;
}
