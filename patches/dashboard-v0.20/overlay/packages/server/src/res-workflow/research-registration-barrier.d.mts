export function createResearchRegistrationBarrier(): {
  register(sessionId: string, associate: () => unknown | Promise<unknown>): Promise<void>;
  deliver(sessionId: string, callback: () => void, options?: { deferred?: boolean }): Promise<boolean>;
  clear(sessionId: string): void;
};
