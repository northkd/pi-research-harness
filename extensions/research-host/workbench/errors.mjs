export class ResWorkflowError extends Error {
  constructor(statusCode, code, message = code) {
    super(message);
    this.name = 'ResWorkflowError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export async function resolveInstalledResearchLoopRoot() {
  throw new ResWorkflowError(503, 'research-loop-root-required');
}
