export function isResearchDispatchReceiptId(value: unknown): value is string;
export function createResearchReceiptHandler<T extends { type: string; [key: string]: any }, R>(options: {
  handle(message: T): R | Promise<R>;
  getSessionId(): string;
  readHistory?(): any[];
  sendAck(message: { type: 'prompt_received'; sessionId: string; promptId: string; fresh: boolean }): void;
}): (message: T) => Promise<Awaited<R> | undefined>;
