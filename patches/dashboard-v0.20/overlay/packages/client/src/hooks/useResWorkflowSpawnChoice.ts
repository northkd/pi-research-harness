import { useCallback, useEffect, useRef, useState } from "react";
import { getApiBase } from "../lib/api/api-context.js";
import { getResWorkflowConnection } from "../lib/api/res-workflow-api.js";
import { encodeFolderPath } from "../lib/util/folder-encoding.js";
import type { useSessionActions } from "./useSessionActions.js";

type SpawnSession = ReturnType<typeof useSessionActions>["handleSpawnSession"];
type SpawnArgs = Parameters<SpawnSession>;
export type RequestNewSession = (...args: SpawnArgs) => Promise<string | undefined>;

export interface ResWorkflowSpawnChoiceState {
  cwd: string;
  status: "checking" | "choice" | "error";
  error?: string;
}

interface PendingChoice {
  args: SpawnArgs;
  scope: string;
  viewKey: string;
  nextViewKey?: string;
  presented: boolean;
  status: ResWorkflowSpawnChoiceState["status"];
  controller: AbortController | null;
  promise: Promise<string | undefined>;
  resolve: (id: string | undefined) => void;
}

export function useResWorkflowSpawnChoice({ apiBase, connectionKey, viewKey, onSpawnSession, onOpenFolder, onDispatchError }: {
  apiBase: string;
  connectionKey: string;
  viewKey: string;
  onSpawnSession: SpawnSession;
  onOpenFolder: (cwd: string) => void;
  onDispatchError?: () => void;
}) {
  const scope = JSON.stringify([apiBase, connectionKey]);
  const latest = useRef({ apiBase, scope, viewKey, onSpawnSession, onOpenFolder, onDispatchError });
  latest.current = { apiBase, scope, viewKey, onSpawnSession, onOpenFolder, onDispatchError };
  const pending = useRef<PendingChoice | null>(null);
  const mounted = useRef(true);
  const [choice, setChoice] = useState<ResWorkflowSpawnChoiceState | null>(null);

  const isCurrent = useCallback((record: PendingChoice) => pending.current === record && mounted.current
    && record.scope === latest.current.scope && getApiBase() === latest.current.apiBase
    && (latest.current.viewKey === record.viewKey || latest.current.viewKey === record.nextViewKey), []);

  const settle = useCallback((record: PendingChoice, id?: string) => {
    if (pending.current !== record) return;
    pending.current = null;
    record.controller?.abort();
    if (mounted.current) setChoice(null);
    record.resolve(id);
  }, []);

  const cancel = useCallback(() => { if (pending.current) settle(pending.current); }, [settle]);

  const dispatch = useCallback((record: PendingChoice, join: boolean) => {
    if (!isCurrent(record)) return;
    pending.current = null;
    record.controller?.abort();
    setChoice(null);
    const args: SpawnArgs = join ? [record.args[0], record.args[1], { ...record.args[2], joinResWorkflow: true }] : record.args;
    try {
      record.resolve(latest.current.onSpawnSession(...args));
    } catch {
      record.resolve(undefined);
      latest.current.onDispatchError?.();
    }
  }, [isCurrent]);

  const readConnection = useCallback(async (record: PendingChoice) => {
    if (!isCurrent(record)) return;
    record.controller?.abort();
    const controller = new AbortController();
    record.controller = controller;
    record.status = "checking";
    setChoice({ cwd: record.args[0], status: "checking" });
    const present = (status: "choice" | "error", error?: string) => {
      record.status = status;
      setChoice({ cwd: record.args[0], status, ...(error ? { error } : {}) });
      if (!record.presented) {
        record.presented = true;
        const target = `/folder/${encodeFolderPath(record.args[0])}`;
        if (latest.current.viewKey !== target && latest.current.viewKey !== `${target}/research`) {
          record.nextViewKey = target;
          latest.current.onOpenFolder(record.args[0]);
        }
      }
    };
    try {
      const connection = await getResWorkflowConnection(record.args[0], controller.signal);
      if (!isCurrent(record) || controller.signal.aborted || record.controller !== controller) return;
      if (connection.adopted) present("choice");
      else dispatch(record, false);
    } catch (error) {
      if (!isCurrent(record) || controller.signal.aborted || record.controller !== controller) return;
      present("error", error instanceof Error ? error.message : String(error));
    }
  }, [dispatch, isCurrent]);

  const requestNewSession = useCallback<RequestNewSession>((...args) => {
    if (!mounted.current || getApiBase() !== latest.current.apiBase) return Promise.resolve(undefined);
    const frozenArgs: SpawnArgs = [...args];
    if (frozenArgs[2]) {
      frozenArgs[2] = { ...frozenArgs[2] };
      delete frozenArgs[2].joinResWorkflow;
    }
    const previous = pending.current;
    if (previous && isCurrent(previous) && JSON.stringify(previous.args) === JSON.stringify(frozenArgs)) return previous.promise;
    if (previous) settle(previous);
    let resolve!: PendingChoice["resolve"];
    const promise = new Promise<string | undefined>(yes => { resolve = yes; });
    const record: PendingChoice = { args: frozenArgs, scope: latest.current.scope, viewKey: latest.current.viewKey, presented: false, status: "checking", controller: null, promise, resolve };
    pending.current = record;
    void readConnection(record);
    return promise;
  }, [isCurrent, readConnection, settle]);

  const choose = useCallback((join: boolean) => {
    const record = pending.current;
    if (!record || record.status === "checking" || join && record.status !== "choice") return;
    dispatch(record, join);
  }, [dispatch]);

  const retry = useCallback(() => {
    const record = pending.current;
    if (record?.status === "error") void readConnection(record);
  }, [readConnection]);

  useEffect(() => {
    const record = pending.current;
    if (!record) return;
    if (!isCurrent(record)) settle(record);
    else if (record.nextViewKey === viewKey) {
      // Allow our own navigation once, then fence any later departure.
      record.viewKey = viewKey;
      record.nextViewKey = undefined;
    }
  }, [scope, viewKey, isCurrent, settle]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; if (pending.current) settle(pending.current); };
  }, [settle]);

  return { choice: pending.current && isCurrent(pending.current) ? choice : null, requestNewSession, choose, retry, cancel };
}
