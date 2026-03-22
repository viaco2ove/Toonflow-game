import { AsyncLocalStorage } from "node:async_hooks";

interface RequestContextState {
  userId: number;
}

const requestContextStore = new AsyncLocalStorage<RequestContextState>();

export function runWithRequestContext<T>(state: RequestContextState, callback: () => T): T {
  return requestContextStore.run(state, callback);
}

export function getRequestContext(): RequestContextState | undefined {
  return requestContextStore.getStore();
}

export function getCurrentUserId(fallback: number = 0): number {
  const uid = Number(getRequestContext()?.userId);
  if (Number.isFinite(uid) && uid > 0) return uid;
  return fallback;
}
