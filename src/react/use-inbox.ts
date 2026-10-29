import { useCallback, useEffect, useRef, useState } from "react";

export type InboxNotification = {
  id: string;
  userId: string;
  organizationId?: string | null;
  type: string;
  title: string;
  body?: string | null;
  href?: string | null;
  data?: Record<string, unknown> | null;
  read: boolean;
  seenAt?: Date | string | null;
  createdAt: Date | string;
};

type ListQuery = {
  limit?: number;
  offset?: number;
  filter?: "unread" | "all";
  organizationId?: string;
};

export type InboxFetchClient = {
  inbox: {
    list: (input: { query: ListQuery }) => Promise<{
      data: { notifications: InboxNotification[]; hasMore: boolean } | null;
      error: unknown;
    }>;
    unreadCount: (input?: { query?: { organizationId?: string } }) => Promise<{
      data: { count: number } | null;
      error: unknown;
    }>;
    markRead: (input: {
      id: string;
    }) => Promise<{ data: unknown; error: unknown }>;
    markAllRead: (input: {
      organizationId?: string;
    }) => Promise<{ data: unknown; error: unknown }>;
    /**
     * Required: without it nothing is marked seen, and every "email if unread"
     * goes out even for notifications the person looked at.
     */
    markSeen: (input: {
      ids: string[];
    }) => Promise<{ data: unknown; error: unknown }>;
  };
};

export type UseInboxOptions = {
  /** Poll interval for the unread count in ms. 0 disables polling. @default 30000 */
  pollInterval?: number;
  /** Page size for the notification list. @default 20 */
  pageSize?: number;
  /** Only fetch unread notifications, so a page is a full page. @default "all" */
  filter?: "unread" | "all";
  /** Scope everything to one organization. */
  organizationId?: string;
  /** Refresh when the tab becomes visible again (skipped if the data is under 5s old). @default true */
  refreshOnFocus?: boolean;
};

// Automatic refreshes (the tab becoming visible) within this window of the last
// successful one are skipped (refreshIfStale). Explicit refresh() calls ignore
// it, though they still join a request already in flight for the same scope.
const STALE_MS = 5_000;

// Retries for a count that failed to refetch after a write: three, then the
// error is reported. The badge would otherwise sit on the optimistic value.
const COUNT_RETRY_MS = [1_000, 2_000, 4_000];

const isHidden = () =>
  typeof document !== "undefined" && document.visibilityState === "hidden";

export function useInbox(
  client: InboxFetchClient,
  options: UseInboxOptions = {},
) {
  const {
    pollInterval = 30_000,
    pageSize = 20,
    filter = "all",
    organizationId,
    refreshOnFocus = true,
  } = options;

  const [notifications, setNotifications] = useState<InboxNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const clientRef = useRef(client);
  clientRef.current = client;

  // Every request belongs to the scope it was made for. When the scope changes
  // mid-flight (an organizationId that resolves after mount, a tab switch), the
  // old response can land after the new one; applying it would show another
  // scope's count and rows. Callbacks capture their scope and drop stale results.
  const scope = `${organizationId ?? ""}|${filter}|${pageSize}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  const listQuery = useCallback(
    (offset: number): ListQuery => ({
      limit: pageSize,
      offset,
      ...(filter === "unread" ? { filter } : {}),
      ...(organizationId ? { organizationId } : {}),
    }),
    [pageSize, filter, organizationId],
  );

  // A write is a window: it bumps the counter when it starts and again when its
  // POST settles. Count responses that started anywhere in the window are dropped,
  // so a pre-commit value can't land after the revalidation. Reads record the
  // counter at both ends, so a list from before the write or during the POST
  // gets patched. A list computed during the POST still misses the write, so the
  // settle re-applies it to the rows held. markAllRead marks its scope at start
  // only (lists from before it can't hold post-commit rows) and its settle marks
  // just the rows it held. A failed POST drops its marks and flips back its rows,
  // unless a later write claimed the same id.
  const mutationsRef = useRef(0);
  const readsRef = useRef(new Map<string, number>());
  const allReadAtRef = useRef(new Map<string, number>());

  // The mount, poll and visibility refreshes below have no awaiter. The transport
  // rejects (rather than resolving to { error }) when the request never reaches
  // the server, an offline tab, and without a catch that is an unhandled rejection.
  const captureBackgroundError = useCallback((reason: unknown) => {
    setError(() => reason);
  }, []);

  const refreshUnreadCount = useCallback(async () => {
    const started = mutationsRef.current;
    const res = await clientRef.current.inbox.unreadCount(
      organizationId ? { query: { organizationId } } : undefined,
    );
    if (
      res.data &&
      scopeRef.current === scope &&
      mutationsRef.current === started
    ) {
      setUnreadCount(res.data.count);
    }
  }, [organizationId, scope]);

  // The count after a write settles. Unlike refreshUnreadCount it sees a failed
  // fetch (a rejected transport, or { error } with no data) and retries, since a
  // badge left on the optimistic count stays wrong until the next panel open or
  // visibility change, or forever with pollInterval 0. It skips runRefresh's
  // in-flight dedupe: a request already in flight started before this write.
  const countRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(false);

  const cancelCountRetry = useCallback(() => {
    if (countRetryRef.current) clearTimeout(countRetryRef.current);
    countRetryRef.current = null;
  }, []);

  const revalidateCount = useCallback(
    async (write: number, attempt: number) => {
      const attemptScope = scopeRef.current;
      const started = mutationsRef.current;
      let reason: unknown = null;
      try {
        const res = await clientRef.current.inbox.unreadCount(
          organizationId ? { query: { organizationId } } : undefined,
        );
        if (res.data) {
          if (
            scopeRef.current === attemptScope &&
            mutationsRef.current === started
          ) {
            setUnreadCount(res.data.count);
          }
          return;
        }
        reason = res.error;
      } catch (err) {
        reason = err;
      }
      // a newer write, a scope change or an unmount each takes over from this chain
      if (
        !mountedRef.current ||
        scopeRef.current !== attemptScope ||
        mutationsRef.current !== write
      ) {
        return;
      }
      const delay = COUNT_RETRY_MS[attempt];
      if (delay !== undefined) {
        countRetryRef.current = setTimeout(() => {
          countRetryRef.current = null;
          void revalidateCountRef.current(write, attempt + 1);
        }, delay);
        return;
      }
      // { error } lands in error state the way a list error does: it is the
      // server's answer, and a silently stale badge is the worse outcome
      captureBackgroundError(reason);
    },
    [organizationId, captureBackgroundError],
  );

  // Revalidation is a ref so a settle that lands after a scope change refetches
  // the current scope's count. The captured one would drop its own response.
  const revalidateCountRef = useRef(revalidateCount);
  revalidateCountRef.current = revalidateCount;

  // List responses are applied, not dropped: they carry notifications that
  // arrived since mount, and the panel must show them. Only reads made after
  // the request started are missing from them, so those are put back. A read
  // id is the same notification in any scope; a markAllRead only covers its own.
  const withLocalReads = useCallback(
    (rows: InboxNotification[], since: number, scope: string) => {
      const allReadAt = allReadAtRef.current.get(scope) ?? 0;
      return rows.map((n) =>
        !n.read &&
        (allReadAt > since || (readsRef.current.get(n.id) ?? 0) > since)
          ? { ...n, read: true }
          : n,
      );
    },
    [],
  );

  // Mount, tab visibility and panel open can all fire within a few ms of each other.
  // Calls for the same scope share one in-flight request, and automatic
  // triggers skip a refresh when this scope's data is still fresh. Both are
  // keyed by scope so a scope change always fetches.
  const inFlightRef = useRef<{ scope: string; promise: Promise<void> } | null>(
    null,
  );
  const lastRefreshRef = useRef<{ scope: string; at: number } | null>(null);

  const runRefresh = useCallback(
    (ifStale: boolean) => {
      const inFlight = inFlightRef.current;
      if (inFlight?.scope === scope) return inFlight.promise;
      const last = lastRefreshRef.current;
      if (
        ifStale &&
        last?.scope === scope &&
        Date.now() - last.at < STALE_MS
      ) {
        return Promise.resolve();
      }

      const promise = (async () => {
        try {
          const started = mutationsRef.current;
          const [list] = await Promise.all([
            clientRef.current.inbox.list({ query: listQuery(0) }),
            refreshUnreadCount(),
          ]);
          if (scopeRef.current !== scope) return;
          if (list.error) {
            setError(list.error);
          } else if (list.data) {
            setError(null);
            setNotifications(
              withLocalReads(list.data.notifications, started, scope),
            );
            setHasMore(list.data.hasMore);
            lastRefreshRef.current = { scope, at: Date.now() };
          }
        } finally {
          // a transport failure still ends the initial load, otherwise a client
          // that mounts while offline renders a spinner forever
          if (scopeRef.current === scope) setIsLoading(false);
        }
      })().finally(() => {
        if (inFlightRef.current?.promise === promise) inFlightRef.current = null;
      });
      inFlightRef.current = { scope, promise };
      return promise;
    },
    [listQuery, refreshUnreadCount, scope, withLocalReads],
  );
  // no parameters, so `onClick={inbox.refresh}` keeps type-checking
  const refresh = useCallback(() => runRefresh(false), [runRefresh]);
  const refreshIfStale = useCallback(() => runRefresh(true), [runRefresh]);

  const notificationsRef = useRef(notifications);
  notificationsRef.current = notifications;

  const loadMore = useCallback(async () => {
    // A write that commits while the page is in flight shifts the unread set
    // under the offset, so the page starts too far along and skips a row. Refetch
    // from the recomputed offset instead, at most twice; the id dedupe absorbs
    // any overlap. Concurrent loadMore calls need no guard: they only overlap.
    for (let refetches = 0; ; refetches++) {
      // Under the unread filter the server's result set shrinks as we mark things
      // read, so paging by list length would skip that many rows. The unread
      // notifications we hold are still the head of that set — count only those.
      const loaded =
        filter === "unread"
          ? notificationsRef.current.filter((n) => !n.read).length
          : notificationsRef.current.length;
      const started = mutationsRef.current;
      const res = await clientRef.current.inbox.list({
        query: listQuery(loaded),
      });
      if (!res.data || scopeRef.current !== scope) return;
      const shifted = filter === "unread" && mutationsRef.current !== started;
      if (shifted && refetches < 2) continue;
      const page = withLocalReads(res.data.notifications, started, scope);
      setNotifications((prev) => {
        const seen = new Set(prev.map((n) => n.id));
        return [...prev, ...page.filter((n) => !seen.has(n.id))];
      });
      setHasMore(res.data.hasMore);
      return;
    }
  }, [listQuery, filter, scope, withLocalReads]);

  // The count is revalidated after the POST, in finally, so a failed POST also
  // resyncs the badge. It is not awaited, so the write settles with its POST. It
  // calls revalidateCount, not refresh(): refresh would join a request already
  // in flight, which started before this write.
  const markRead = useCallback(
    async (id: string) => {
      mutationsRef.current += 1;
      cancelCountRetry();
      const write = mutationsRef.current;
      const prevRead = readsRef.current.get(id);
      readsRef.current.set(id, write);
      const target = notificationsRef.current.find((n) => n.id === id);
      const flipped = !!target && !target.read;
      if (flipped) {
        setNotifications((prev) =>
          prev.map((n) => (n.id === id ? { ...n, read: true } : n)),
        );
        setUnreadCount((count) => Math.max(0, count - 1));
      }
      let committed = false;
      try {
        await clientRef.current.inbox.markRead({ id });
        committed = true;
      } finally {
        mutationsRef.current += 1;
        const settledAt = mutationsRef.current;
        if (committed) {
          readsRef.current.set(id, settledAt);
          // a list computed during the POST missed this read, and nothing else re-applies it
          setNotifications((prev) =>
            prev.map((n) => (n.id === id && !n.read ? { ...n, read: true } : n)),
          );
        } else if (readsRef.current.get(id) === write) {
          // not committed: drop this write's mark, and flip back the row it changed
          // unless an earlier claim (prevRead) still holds the id. A later write
          // on the id has its own mark, so this one leaves it alone.
          if (prevRead === undefined) readsRef.current.delete(id);
          else readsRef.current.set(id, prevRead);
          if (flipped && prevRead === undefined) {
            setNotifications((prev) =>
              prev.map((n) => (n.id === id ? { ...n, read: false } : n)),
            );
          }
        }
        void revalidateCountRef.current(settledAt, 0);
      }
    },
    [cancelCountRetry],
  );

  // Seen is what cancels a pending "email if unread" delivery. Ids go out once
  // per mount; a failed request releases them for the next render to retry.
  const sentSeenRef = useRef(new Set<string>());
  const markSeen = useCallback(async (ids: string[]) => {
    const fresh = ids.filter((id) => !sentSeenRef.current.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) sentSeenRef.current.add(id);
    const seenAt = new Date();
    const freshIds = new Set(fresh);
    setNotifications((prev) =>
      prev.map((n) => (freshIds.has(n.id) && !n.seenAt ? { ...n, seenAt } : n)),
    );
    // the endpoint takes 100 ids, and a few Load more clicks can pass that
    for (let i = 0; i < fresh.length; i += 100) {
      const chunk = fresh.slice(i, i + 100);
      try {
        const res = await clientRef.current.inbox.markSeen({ ids: chunk });
        if (res.error) throw res.error;
      } catch {
        for (const id of chunk) sentSeenRef.current.delete(id);
      }
    }
  }, []);

  const markAllRead = useCallback(async () => {
    mutationsRef.current += 1;
    cancelCountRetry();
    const write = mutationsRef.current;
    const prevAllRead = allReadAtRef.current.get(scope);
    allReadAtRef.current.set(scope, write);
    // Only these rows are known to exist at the commit. A row that arrives during
    // the POST may be post-commit, so the settle leaves it alone. The cost: one
    // that arrived before the commit and is listed in the window stays unread
    // until the next refresh. The count is still right.
    const held = new Set(
      notificationsRef.current.filter((n) => !n.read).map((n) => n.id),
    );
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    setUnreadCount(0);
    let committed = false;
    try {
      await clientRef.current.inbox.markAllRead(
        organizationId ? { organizationId } : {},
      );
      committed = true;
    } finally {
      mutationsRef.current += 1;
      const settledAt = mutationsRef.current;
      // Rows now belong to another scope if it moved on, so leave them alone.
      const inScope = scopeRef.current === scope;
      if (committed) {
        for (const id of held) readsRef.current.set(id, settledAt);
        // same as markRead: a list computed during the POST missed this write
        if (inScope) {
          setNotifications((prev) =>
            prev.map((n) =>
              held.has(n.id) && !n.read ? { ...n, read: true } : n,
            ),
          );
        }
      } else {
        // drop this write's scope mark, unless a later write replaced it
        if (allReadAtRef.current.get(scope) === write) {
          if (prevAllRead === undefined) allReadAtRef.current.delete(scope);
          else allReadAtRef.current.set(scope, prevAllRead);
        }
        // a markRead that claimed an id after this write started keeps its row read
        if (inScope) {
          setNotifications((prev) =>
            prev.map((n) =>
              held.has(n.id) && n.read && (readsRef.current.get(n.id) ?? 0) <= write
                ? { ...n, read: false }
                : n,
            ),
          );
        }
      }
      void revalidateCountRef.current(settledAt, 0);
    }
  }, [organizationId, scope, cancelCountRetry]);

  useEffect(() => {
    refresh().catch(captureBackgroundError);
  }, [refresh, captureBackgroundError]);

  // A pending retry belongs to the scope and mount it was scheduled in, so a
  // scope change or unmount drops it. An attempt still in flight sees the flag.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelCountRetry();
    };
  }, [scope, cancelCountRetry]);

  useEffect(() => {
    if (pollInterval <= 0) return;
    const interval = setInterval(() => {
      // nobody sees the badge of a hidden tab; the visibility refresh (or the
      // next tick, with refreshOnFocus off) catches it up
      if (isHidden()) return;
      refreshUnreadCount().catch(captureBackgroundError);
    }, pollInterval);
    return () => clearInterval(interval);
  }, [pollInterval, refreshUnreadCount, captureBackgroundError]);

  // visibilitychange rather than window focus: focus fires on every return
  // from devtools, an iframe or another window, visibility only when the tab
  // was actually backgrounded
  useEffect(() => {
    if (!refreshOnFocus) return;
    const onVisibilityChange = () => {
      if (isHidden()) return;
      refreshIfStale().catch(captureBackgroundError);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [refreshOnFocus, refreshIfStale, captureBackgroundError]);

  return {
    notifications,
    unreadCount,
    isLoading,
    hasMore,
    error,
    filter,
    refresh,
    refreshIfStale,
    loadMore,
    markRead,
    markSeen,
    markAllRead,
  };
}
