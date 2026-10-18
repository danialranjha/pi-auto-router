/**
 * Session state that all sessions in one process share.
 *
 * pi caches an extension module per working directory. The main session and
 * each in-process subagent session therefore run the same copy of this module.
 * A session that ends must remove only its own state. If it clears state for
 * all sessions, the next request of a live session finds no model registry.
 */

function read<T>(get: () => T): T | undefined {
  try {
    return get();
  } catch {
    // pi makes a context throw after its session ends.
    return undefined;
  }
}

export function sessionIdOf(ctx: any): string | undefined {
  return read(() => ctx?.sessionManager?.getSessionId?.());
}

/**
 * onEnd receives the id of each session that ends. This includes a session
 * whose context became stale without a session_shutdown event. onEmpty runs
 * when an operation removes the last live session, including lazy pruning.
 */
export function createSessionTracker(
  onEnd: (sessionId: string) => void = () => {},
  onEmpty: () => void = () => {},
) {
  // Insertion order is recency order: update() moves a session to the end.
  const live = new Map<string, { ctx: any; active: boolean }>();
  let lastRegistry: any;

  const remove = (id: string) => {
    const entry = live.get(id);
    if (!entry) return;
    entry.active = false;
    live.delete(id);
    onEnd(id);
  };

  // pi-subagents can dispose a child without session_shutdown. Its context
  // then throws, or it reports a different session id after a replacement.
  const prune = () => {
    for (const [id, entry] of live) {
      if (sessionIdOf(entry.ctx) !== id) remove(id);
    }
  };

  const settle = (hadSessions: boolean) => {
    prune();
    if (hadSessions && live.size === 0) onEmpty();
  };

  const pruneAndSettle = () => settle(live.size > 0);

  return {
    /** Store the context of a session event, and make its session current. */
    update(ctx: any): void {
      const hadSessions = live.size > 0;
      const registry = read(() => ctx?.modelRegistry);
      if (registry) lastRegistry = registry;
      prune();
      const id = sessionIdOf(ctx);
      if (id) {
        const entry = live.get(id) ?? { ctx, active: true };
        entry.ctx = ctx;
        live.delete(id);
        live.set(id, entry);
      }
      // Finish replacement before notifying: a new live session keeps the adapter.
      settle(hadSessions);
    },

    /**
     * Remove the session of an ended context, and every stale session. The
     * most recent live session becomes current. pi makes a new context object
     * for each event, but it invalidates all contexts of a session together.
     * So if the ended context is stale, prune() removes its stored context.
     */
    end(ctx: any): void {
      const hadSessions = live.size > 0;
      const id = sessionIdOf(ctx);
      if (id) remove(id);
      settle(hadSessions);
    },

    context(): any {
      pruneAndSettle();
      return [...live.values()].at(-1)?.ctx;
    },

    sessionId(): string | undefined {
      pruneAndSettle();
      return [...live.keys()].at(-1);
    },

    hasLiveSessions(): boolean {
      pruneAndSettle();
      return live.size > 0;
    },

    /** Bind a request to its session lifetime; unknown callers stay unguarded. */
    captureLiveness(id?: string): (() => boolean) | undefined {
      pruneAndSettle();
      const entry = id ? live.get(id) : undefined;
      if (!entry) return undefined;
      return () => {
        pruneAndSettle();
        return entry.active;
      };
    },

    /**
     * The registry of the current context. If no context gives one, the last
     * registry that any context gave. A ModelRegistry wraps the process model
     * runtime, so it stays valid after its session ends.
     */
    registry(): any {
      return read(() => this.context()?.modelRegistry) ?? lastRegistry;
    },
  };
}
