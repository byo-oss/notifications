// @vitest-environment happy-dom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useInbox, type InboxFetchClient } from "./use-inbox";

function makeNotification(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    userId: "u1",
    type: "test",
    title: `Notification ${id}`,
    read: false,
    createdAt: new Date(),
    ...overrides,
  };
}

function makeMockClient(
  notifications = [makeNotification("n1"), makeNotification("n2")],
) {
  const client = {
    inbox: {
      list: vi.fn().mockResolvedValue({
        data: { notifications, hasMore: false },
        error: null,
      }),
      unreadCount: vi.fn().mockResolvedValue({
        data: { count: notifications.filter((n) => !n.read).length },
        error: null,
      }),
      markRead: vi.fn().mockResolvedValue({ data: {}, error: null }),
      markAllRead: vi.fn().mockResolvedValue({ data: { count: 0 }, error: null }),
      markSeen: vi.fn().mockResolvedValue({ data: { count: 0 }, error: null }),
    },
  } satisfies InboxFetchClient;
  return client;
}

// state set by timers only lands when act flushes it
function advance(ms: number) {
  return act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("useInbox", () => {
  it("loads notifications and unread count on mount", async () => {
    const client = makeMockClient();
    const { result } = renderHook(() => useInbox(client));

    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.notifications).toHaveLength(2);
    expect(result.current.unreadCount).toBe(2);
    expect(result.current.hasMore).toBe(false);
    expect(client.inbox.list).toHaveBeenCalledWith({
      query: { limit: 20, offset: 0 },
    });
  });

  it("polls the unread count on the interval and refreshes when the tab becomes visible", async () => {
    vi.useFakeTimers();
    try {
      const client = makeMockClient();
      renderHook(() => useInbox(client, { pollInterval: 1000 }));

      await vi.advanceTimersByTimeAsync(0);
      expect(client.inbox.unreadCount).toHaveBeenCalledTimes(1);
      expect(client.inbox.list).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1000);
      expect(client.inbox.unreadCount).toHaveBeenCalledTimes(2);
      expect(client.inbox.list).toHaveBeenCalledTimes(1);

      // past the staleness window, so becoming visible refetches
      await vi.advanceTimersByTimeAsync(5000);
      setVisibility("hidden");
      setVisibility("visible");
      await vi.advanceTimersByTimeAsync(0);
      expect(client.inbox.list).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      setVisibility("visible");
    }
  });

  // #5: window focus fired a full refresh on every return from devtools or
  // another window, with nothing collapsing the bursts
  it("ignores window focus and skips visibility refreshes while data is fresh", async () => {
    vi.useFakeTimers();
    try {
      const client = makeMockClient();
      renderHook(() => useInbox(client, { pollInterval: 0 }));
      await vi.advanceTimersByTimeAsync(0);
      expect(client.inbox.list).toHaveBeenCalledTimes(1);

      for (let i = 0; i < 5; i++) {
        window.dispatchEvent(new Event("focus"));
        setVisibility("hidden");
        setVisibility("visible");
        await vi.advanceTimersByTimeAsync(500);
      }
      expect(client.inbox.list).toHaveBeenCalledTimes(1);
      expect(client.inbox.unreadCount).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      setVisibility("visible");
    }
  });

  it("does not refresh on visibility when refreshOnFocus is false", async () => {
    vi.useFakeTimers();
    try {
      const client = makeMockClient();
      renderHook(() =>
        useInbox(client, { pollInterval: 0, refreshOnFocus: false }),
      );
      await vi.advanceTimersByTimeAsync(10_000);
      setVisibility("hidden");
      setVisibility("visible");
      await vi.advanceTimersByTimeAsync(0);
      expect(client.inbox.list).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      setVisibility("visible");
    }
  });

  it("does not poll while the tab is hidden", async () => {
    vi.useFakeTimers();
    try {
      const client = makeMockClient();
      renderHook(() => useInbox(client, { pollInterval: 1000 }));
      await vi.advanceTimersByTimeAsync(0);
      expect(client.inbox.unreadCount).toHaveBeenCalledTimes(1);

      setVisibility("hidden");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(client.inbox.unreadCount).toHaveBeenCalledTimes(1);

      // coming back after the data went stale catches up with one refresh
      setVisibility("visible");
      await vi.advanceTimersByTimeAsync(0);
      expect(client.inbox.list).toHaveBeenCalledTimes(2);
      expect(client.inbox.unreadCount).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      setVisibility("visible");
    }
  });

  it("shares one request between concurrent refreshes; an explicit refresh ignores staleness", async () => {
    const client = makeMockClient();
    const { result } = renderHook(() => useInbox(client, { pollInterval: 0 }));

    // mount's refresh is still in flight; these join it
    await act(() =>
      Promise.all([
        result.current.refresh(),
        result.current.refreshIfStale(),
      ]),
    );
    expect(client.inbox.list).toHaveBeenCalledTimes(1);

    // fresh data: an automatic-style refresh is skipped, an explicit one is not
    await act(() => result.current.refreshIfStale());
    expect(client.inbox.list).toHaveBeenCalledTimes(1);
    await act(() => result.current.refresh());
    expect(client.inbox.list).toHaveBeenCalledTimes(2);
  });

  // A visible tab keeps polling while the network comes and goes, so the
  // transport rejects (TypeError) rather than resolving to { data, error }.
  it("surfaces a rejected poll as error state instead of an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const client = makeMockClient();
      const { result } = renderHook(() => useInbox(client, { pollInterval: 20 }));

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(result.current.unreadCount).toBe(2);

      const offline = new TypeError("Failed to fetch");
      client.inbox.unreadCount.mockRejectedValueOnce(offline);

      await waitFor(() => expect(result.current.error).toBe(offline));

      // give anything that escaped the hook time to reach the process handler
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandled).toEqual([]);

      // the last known count survives a failed poll
      expect(result.current.unreadCount).toBe(2);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("keeps polling after a failed poll and recovers", async () => {
    const client = makeMockClient();
    // the very first refresh fails, i.e. the tab was already offline on mount
    client.inbox.unreadCount.mockRejectedValueOnce(
      new TypeError("Failed to fetch"),
    );

    const { result } = renderHook(() => useInbox(client, { pollInterval: 20 }));

    // a failed mount refresh must not strand the consumer in a loading state
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBeInstanceOf(TypeError);

    // network returns: the interval is still alive and picks the count back up
    client.inbox.unreadCount.mockResolvedValue({
      data: { count: 7 },
      error: null,
    });
    await waitFor(() => expect(result.current.unreadCount).toBe(7));
  });

  it("passes the unread filter through to the list query", async () => {
    const client = makeMockClient();
    const { result } = renderHook(() =>
      useInbox(client, { filter: "unread", pageSize: 5 }),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(client.inbox.list).toHaveBeenCalledWith({
      query: { limit: 5, offset: 0, filter: "unread" },
    });
  });

  it("refetches when the filter changes", async () => {
    const client = makeMockClient();
    const { result, rerender } = renderHook(
      ({ filter }: { filter: "unread" | "all" }) => useInbox(client, { filter }),
      { initialProps: { filter: "all" as "unread" | "all" } },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(client.inbox.list).toHaveBeenCalledWith({
      query: { limit: 20, offset: 0 },
    });

    rerender({ filter: "unread" });
    await waitFor(() =>
      expect(client.inbox.list).toHaveBeenCalledWith({
        query: { limit: 20, offset: 0, filter: "unread" },
      }),
    );
  });

  // A consumer that resolves its organization after mount (a client-side
  // session fetch) renders the hook unscoped first. If that unscoped request
  // lands after the scoped one, the badge shows every organization's unread.
  it("ignores responses for a scope it has since left", async () => {
    const client = makeMockClient();
    type Count = { data: { count: number }; error: null };
    type List = {
      data: { notifications: ReturnType<typeof makeNotification>[]; hasMore: boolean };
      error: null;
    };
    const counts: ((v: Count) => void)[] = [];
    const lists: ((v: List) => void)[] = [];
    client.inbox.unreadCount.mockImplementation(
      () => new Promise<Count>((resolve) => counts.push(resolve)),
    );
    client.inbox.list.mockImplementation(
      () => new Promise<List>((resolve) => lists.push(resolve)),
    );

    const { result, rerender } = renderHook(
      ({ organizationId }: { organizationId?: string }) =>
        useInbox(client, { organizationId, pollInterval: 0 }),
      { initialProps: {} as { organizationId?: string } },
    );
    await waitFor(() => expect(counts).toHaveLength(1));

    rerender({ organizationId: "org1" });
    await waitFor(() => expect(counts).toHaveLength(2));

    await act(async () => {
      counts[1]!({ data: { count: 3 }, error: null });
      lists[1]!({
        data: { notifications: [makeNotification("scoped")], hasMore: false },
        error: null,
      });
    });
    await act(async () => {
      counts[0]!({ data: { count: 39 }, error: null });
      lists[0]!({
        data: {
          notifications: [makeNotification("a"), makeNotification("b")],
          hasMore: true,
        },
        error: null,
      });
    });

    expect(result.current.unreadCount).toBe(3);
    expect(result.current.notifications.map((n) => n.id)).toEqual(["scoped"]);
    expect(result.current.hasMore).toBe(false);
  });

  // The server's unread set shrinks under us as rows are marked read, so paging
  // by list length would skip exactly as many rows as the user has clicked.
  it("offsets by unread rows held when filtering to unread", async () => {
    const client = makeMockClient([
      makeNotification("n1"),
      makeNotification("n2"),
    ]);
    const { result } = renderHook(() =>
      useInbox(client, { filter: "unread", pageSize: 2 }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.markRead("n1");
    });
    client.inbox.list.mockResolvedValueOnce({
      data: { notifications: [makeNotification("n3")], hasMore: false },
      error: null,
    });
    await act(async () => {
      await result.current.loadMore();
    });

    expect(client.inbox.list).toHaveBeenLastCalledWith({
      query: { limit: 2, offset: 1, filter: "unread" },
    });
    await waitFor(() =>
      expect(result.current.notifications.map((n) => n.id)).toEqual([
        "n1",
        "n2",
        "n3",
      ]),
    );
  });

  it("does not append a row it already holds", async () => {
    const client = makeMockClient();
    const { result } = renderHook(() => useInbox(client, { pageSize: 2 }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // a notification arrived since the first page, shifting everything down one
    client.inbox.list.mockResolvedValueOnce({
      data: {
        notifications: [makeNotification("n2"), makeNotification("n3")],
        hasMore: false,
      },
      error: null,
    });
    await result.current.loadMore();

    await waitFor(() =>
      expect(result.current.notifications.map((n) => n.id)).toEqual([
        "n1",
        "n2",
        "n3",
      ]),
    );
  });

  it("optimistically marks read and decrements the unread count", async () => {
    const client = makeMockClient();
    let resolveMarkRead: (v: { data: unknown; error: null }) => void;
    client.inbox.markRead.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveMarkRead = resolve;
        }),
    );

    const { result } = renderHook(() => useInbox(client));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.unreadCount).toBe(2);

    // state updates before the server responds
    result.current.markRead("n1");
    await waitFor(() => {
      expect(
        result.current.notifications.find((n) => n.id === "n1")?.read,
      ).toBe(true);
      expect(result.current.unreadCount).toBe(1);
    });
    expect(client.inbox.markRead).toHaveBeenCalledWith({ id: "n1" });
    resolveMarkRead!({ data: {}, error: null });
  });

  // A count request that started before a read is answered after it. The
  // stale value must not win, and the revalidation after the POST is what sets
  // the badge.
  it("drops an unread count that started before markRead", async () => {
    const client = makeMockClient([makeNotification("n1")]);
    const { result } = renderHook(() => useInbox(client, { pollInterval: 0 }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.unreadCount).toBe(1);

    const stale = deferred<CountResponse>();
    const revalidated = deferred<CountResponse>();
    client.inbox.unreadCount
      .mockImplementationOnce(() => stale.promise)
      .mockImplementationOnce(() => revalidated.promise);

    const refreshing = result.current.refresh();
    result.current.markRead("n1");
    await waitFor(() => expect(result.current.unreadCount).toBe(0));
    expect(client.inbox.unreadCount).toHaveBeenCalledTimes(3);

    await act(async () => stale.resolve(count(1)));
    await act(() => refreshing);
    expect(result.current.unreadCount).toBe(0);

    await act(async () => revalidated.resolve(count(0)));
    expect(result.current.unreadCount).toBe(0);
  });

  it("drops an unread count that started before markAllRead", async () => {
    const client = makeMockClient([makeNotification("n1"), makeNotification("n2")]);
    const { result } = renderHook(() => useInbox(client, { pollInterval: 0 }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.unreadCount).toBe(2);

    const stale = deferred<CountResponse>();
    const revalidated = deferred<CountResponse>();
    client.inbox.unreadCount
      .mockImplementationOnce(() => stale.promise)
      .mockImplementationOnce(() => revalidated.promise);

    const refreshing = result.current.refresh();
    result.current.markAllRead();
    await waitFor(() => expect(result.current.unreadCount).toBe(0));
    expect(client.inbox.unreadCount).toHaveBeenCalledTimes(3);

    await act(async () => stale.resolve(count(2)));
    await act(() => refreshing);
    expect(result.current.unreadCount).toBe(0);

    await act(async () => revalidated.resolve(count(0)));
    expect(result.current.unreadCount).toBe(0);
  });

  // The list is applied, not dropped: a notification that arrived since mount
  // must still show. Only the read the response predates is put back.
  it("keeps a read row read when a list started before markRead resolves", async () => {
    const client = makeMockClient([makeNotification("n1"), makeNotification("n2")]);
    const { result } = renderHook(() => useInbox(client, { pollInterval: 0 }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const staleList = deferred<ListResponse>();
    client.inbox.list.mockImplementationOnce(() => staleList.promise);
    const refreshing = result.current.refresh();

    await act(() => result.current.markRead("n1"));

    await act(async () =>
      staleList.resolve({
        data: {
          notifications: [
            makeNotification("n1"),
            makeNotification("n2"),
            makeNotification("n3"),
          ],
          hasMore: false,
        },
        error: null,
      }),
    );
    await act(() => refreshing);

    const byId = Object.fromEntries(
      result.current.notifications.map((n) => [n.id, n.read]),
    );
    expect(byId).toEqual({ n1: true, n2: false, n3: false });
  });

  // The POST is the write: a count or list started while it is in flight can
  // carry the pre-commit state, so it must not land after the revalidation.
  it("drops an unread count that started during the markRead POST", async () => {
    const client = makeMockClient();
    const { result } = renderHook(() => useInbox(client, { pollInterval: 0 }));
    await waitFor(() => expect(result.current.unreadCount).toBe(2));

    const post = deferred<{ data: unknown; error: null }>();
    const stale = deferred<CountResponse>();
    client.inbox.markRead.mockImplementationOnce(() => post.promise);
    client.inbox.unreadCount
      .mockImplementationOnce(() => stale.promise) // the refresh below
      .mockResolvedValueOnce(count(1)); // the revalidation after the POST

    let marking!: Promise<void>;
    act(() => {
      marking = result.current.markRead("n1");
    });
    const refreshing = result.current.refresh();

    await act(async () => post.resolve({ data: {}, error: null }));
    await act(() => marking);
    await waitFor(() => expect(result.current.unreadCount).toBe(1));

    // the pre-commit value lands last
    await act(async () => stale.resolve(count(2)));
    await act(() => refreshing);
    expect(result.current.unreadCount).toBe(1);
  });

  it("does not un-read a row when a list started during the markRead POST resolves", async () => {
    const client = makeMockClient([makeNotification("n1"), makeNotification("n2")]);
    const { result } = renderHook(() => useInbox(client, { pollInterval: 0 }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const post = deferred<{ data: unknown; error: null }>();
    const staleList = deferred<ListResponse>();
    client.inbox.markRead.mockImplementationOnce(() => post.promise);
    client.inbox.list.mockImplementationOnce(() => staleList.promise);

    let marking!: Promise<void>;
    act(() => {
      marking = result.current.markRead("n1");
    });
    const refreshing = result.current.refresh();

    await act(async () => post.resolve({ data: {}, error: null }));
    await act(() => marking);

    // the response was computed before the commit, so n1 comes back unread
    await act(async () =>
      staleList.resolve({
        data: {
          notifications: [
            makeNotification("n1"),
            makeNotification("n2"),
            makeNotification("n3"),
          ],
          hasMore: false,
        },
        error: null,
      }),
    );
    await act(() => refreshing);

    const byId = Object.fromEntries(
      result.current.notifications.map((n) => [n.id, n.read]),
    );
    expect(byId).toEqual({ n1: true, n2: false, n3: false });
  });

  // The panel-open refresh started before the click and lands while the POST
  // is still pending: its rows must not flip back to unread.
  it("keeps a row read when a list started before markRead resolves during the POST", async () => {
    const client = makeMockClient([makeNotification("n1"), makeNotification("n2")]);
    const { result } = renderHook(() => useInbox(client, { pollInterval: 0 }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const staleList = deferred<ListResponse>();
    const post = deferred<{ data: unknown; error: null }>();
    client.inbox.list.mockImplementationOnce(() => staleList.promise);
    client.inbox.markRead.mockImplementationOnce(() => post.promise);

    const refreshing = result.current.refresh();
    let marking!: Promise<void>;
    act(() => {
      marking = result.current.markRead("n1");
    });

    await act(async () =>
      staleList.resolve({
        data: {
          notifications: [makeNotification("n1"), makeNotification("n2")],
          hasMore: false,
        },
        error: null,
      }),
    );
    await act(() => refreshing);
    expect(result.current.notifications.find((n) => n.id === "n1")?.read).toBe(true);

    await act(async () => post.resolve({ data: {}, error: null }));
    await act(() => marking);
    expect(result.current.notifications.find((n) => n.id === "n1")?.read).toBe(true);
  });

  it("keeps every row read when a list started before markAllRead resolves during the POST", async () => {
    const client = makeMockClient([makeNotification("n1"), makeNotification("n2")]);
    const { result } = renderHook(() => useInbox(client, { pollInterval: 0 }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const staleList = deferred<ListResponse>();
    const post = deferred<{ data: unknown; error: null }>();
    client.inbox.list.mockImplementationOnce(() => staleList.promise);
    client.inbox.markAllRead.mockImplementationOnce(() => post.promise);

    const refreshing = result.current.refresh();
    let marking!: Promise<void>;
    act(() => {
      marking = result.current.markAllRead();
    });

    await act(async () =>
      staleList.resolve({
        data: {
          notifications: [makeNotification("n1"), makeNotification("n2")],
          hasMore: false,
        },
        error: null,
      }),
    );
    await act(() => refreshing);
    expect(result.current.notifications.every((n) => n.read)).toBe(true);

    await act(async () => post.resolve({ data: {}, error: null }));
    await act(() => marking);
    expect(result.current.notifications.every((n) => n.read)).toBe(true);
  });

  // The list was computed after the click but before the commit, so it still
  // has the row unread. Nothing else re-applies the read, so settle must.
  it("keeps a row read when a list started after markRead resolves before the POST does", async () => {
    const client = makeMockClient([makeNotification("n1"), makeNotification("n2")]);
    const { result } = renderHook(() => useInbox(client, { pollInterval: 0 }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const post = deferred<{ data: unknown; error: null }>();
    const staleList = deferred<ListResponse>();
    client.inbox.markRead.mockImplementationOnce(() => post.promise);
    client.inbox.list.mockImplementationOnce(() => staleList.promise);

    let marking!: Promise<void>;
    act(() => {
      marking = result.current.markRead("n1");
    });
    const refreshing = result.current.refresh();

    await act(async () =>
      staleList.resolve({
        data: {
          notifications: [makeNotification("n1"), makeNotification("n2")],
          hasMore: false,
        },
        error: null,
      }),
    );
    await act(() => refreshing);

    await act(async () => post.resolve({ data: {}, error: null }));
    await act(() => marking);

    const byId = Object.fromEntries(
      result.current.notifications.map((n) => [n.id, n.read]),
    );
    expect(byId).toEqual({ n1: true, n2: false });
  });

  it("keeps every row read when a list started after markAllRead resolves before the POST does", async () => {
    const client = makeMockClient([makeNotification("n1"), makeNotification("n2")]);
    const { result } = renderHook(() => useInbox(client, { pollInterval: 0 }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const post = deferred<{ data: unknown; error: null }>();
    const staleList = deferred<ListResponse>();
    client.inbox.markAllRead.mockImplementationOnce(() => post.promise);
    client.inbox.list.mockImplementationOnce(() => staleList.promise);

    let marking!: Promise<void>;
    act(() => {
      marking = result.current.markAllRead();
    });
    const refreshing = result.current.refresh();

    await act(async () =>
      staleList.resolve({
        data: {
          notifications: [makeNotification("n1"), makeNotification("n2")],
          hasMore: false,
        },
        error: null,
      }),
    );
    await act(() => refreshing);

    await act(async () => post.resolve({ data: {}, error: null }));
    await act(() => marking);
    expect(result.current.notifications.every((n) => n.read)).toBe(true);
  });

  // The POST settles after the scope has moved on. The other scope's rows must
  // not be marked read, and its count must be fetched after the settle.
  it("does not mark another scope's rows read when a markAllRead POST settles after a scope switch", async () => {
    const client = makeMockClient([makeNotification("a1"), makeNotification("a2")]);
    const { result, rerender } = renderHook(
      ({ organizationId }: { organizationId?: string }) =>
        useInbox(client, { organizationId, pollInterval: 0 }),
      { initialProps: { organizationId: "orgA" } },
    );
    await waitFor(() => expect(result.current.unreadCount).toBe(2));

    const post = deferred<{ data: unknown; error: null }>();
    const bList = deferred<ListResponse>();
    const bStaleCount = deferred<CountResponse>();
    client.inbox.markAllRead.mockImplementationOnce(() => post.promise);
    client.inbox.list.mockImplementationOnce(() => bList.promise);
    client.inbox.unreadCount
      .mockImplementationOnce(() => bStaleCount.promise) // orgB's refresh
      .mockResolvedValueOnce(count(1)); // the revalidation after the POST

    let marking!: Promise<void>;
    act(() => {
      marking = result.current.markAllRead();
    });
    rerender({ organizationId: "orgB" });
    await waitFor(() => expect(client.inbox.list).toHaveBeenCalledTimes(2));

    await act(async () => post.resolve({ data: {}, error: null }));
    await act(() => marking);
    await waitFor(() => expect(result.current.unreadCount).toBe(1));
    expect(client.inbox.unreadCount).toHaveBeenLastCalledWith({
      query: { organizationId: "orgB" },
    });

    await act(async () =>
      bList.resolve({
        data: { notifications: [makeNotification("b1")], hasMore: false },
        error: null,
      }),
    );
    await act(async () => bStaleCount.resolve(count(1)));

    expect(result.current.notifications.map((n) => [n.id, n.read])).toEqual([
      ["b1", false],
    ]);
    expect(result.current.unreadCount).toBe(1);
  });

  it("rolls back the rows a failed markAllRead flipped and leaves read rows alone", async () => {
    const client = makeMockClient([
      makeNotification("n1"),
      makeNotification("n2", { read: true }),
    ]);
    const { result } = renderHook(() => useInbox(client, { pollInterval: 0 }));
    await waitFor(() => expect(result.current.unreadCount).toBe(1));

    client.inbox.markAllRead.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await act(async () => {
      await expect(result.current.markAllRead()).rejects.toThrow(
        "Failed to fetch",
      );
    });

    const byId = Object.fromEntries(
      result.current.notifications.map((n) => [n.id, n.read]),
    );
    expect(byId).toEqual({ n1: false, n2: true });
    await waitFor(() => expect(result.current.unreadCount).toBe(1));
  });

  // The POST is pending when a refresh starts, so its list is computed before
  // the commit and still has n1 and n2 unread. n3 arrived after the commit.
  it("leaves a row that arrived during a markAllRead POST unread when its list resolves during the POST", async () => {
    const client = makeMockClient([makeNotification("n1"), makeNotification("n2")]);
    const { result } = renderHook(() => useInbox(client, { pollInterval: 0 }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const post = deferred<{ data: unknown; error: null }>();
    const staleList = deferred<ListResponse>();
    client.inbox.markAllRead.mockImplementationOnce(() => post.promise);
    client.inbox.list.mockImplementationOnce(() => staleList.promise);

    let marking!: Promise<void>;
    act(() => {
      marking = result.current.markAllRead();
    });
    const refreshing = result.current.refresh();

    await act(async () =>
      staleList.resolve({
        data: {
          notifications: [
            makeNotification("n1"),
            makeNotification("n2"),
            makeNotification("n3"),
          ],
          hasMore: false,
        },
        error: null,
      }),
    );
    await act(() => refreshing);

    await act(async () => post.resolve({ data: {}, error: null }));
    await act(() => marking);

    const byId = Object.fromEntries(
      result.current.notifications.map((n) => [n.id, n.read]),
    );
    expect(byId).toEqual({ n1: true, n2: true, n3: false });
  });

  // Same as above, but the list is still in flight when the POST settles. A
  // list from during the POST must not mark n3 read through the settle either.
  it("leaves a row that arrived during a markAllRead POST unread when its list resolves after the settle", async () => {
    const client = makeMockClient([makeNotification("n1"), makeNotification("n2")]);
    const { result } = renderHook(() => useInbox(client, { pollInterval: 0 }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const post = deferred<{ data: unknown; error: null }>();
    const staleList = deferred<ListResponse>();
    client.inbox.markAllRead.mockImplementationOnce(() => post.promise);
    client.inbox.list.mockImplementationOnce(() => staleList.promise);

    let marking!: Promise<void>;
    act(() => {
      marking = result.current.markAllRead();
    });
    const refreshing = result.current.refresh();

    await act(async () => post.resolve({ data: {}, error: null }));
    await act(() => marking);

    await act(async () =>
      staleList.resolve({
        data: {
          notifications: [
            makeNotification("n1"),
            makeNotification("n2"),
            makeNotification("n3"),
          ],
          hasMore: false,
        },
        error: null,
      }),
    );
    await act(() => refreshing);

    const byId = Object.fromEntries(
      result.current.notifications.map((n) => [n.id, n.read]),
    );
    expect(byId).toEqual({ n1: true, n2: true, n3: false });
  });

  // The count revalidation is fire-and-forget. A GET that never answers must not
  // hold the write's promise open, or callers that await markRead hang on it.
  it("settles markRead and markAllRead with the POST, not the count revalidation", async () => {
    const client = makeMockClient([makeNotification("n1"), makeNotification("n2")]);
    const { result } = renderHook(() => useInbox(client, { pollInterval: 0 }));
    await waitFor(() => expect(result.current.unreadCount).toBe(2));

    client.inbox.unreadCount.mockImplementation(() => new Promise(() => {}));
    const markedRead = vi.fn();
    const markedAllRead = vi.fn();
    result.current.markRead("n1").then(markedRead);
    await waitFor(() => expect(markedRead).toHaveBeenCalled());

    result.current.markAllRead().then(markedAllRead);
    await waitFor(() => expect(markedAllRead).toHaveBeenCalled());
  });

  // A POST that fails still leaves the server's count behind; the badge must
  // come back to that value, and markRead keeps rejecting as before.
  it("revalidates the count when the markRead POST fails", async () => {
    const client = makeMockClient();
    const { result } = renderHook(() => useInbox(client, { pollInterval: 0 }));
    await waitFor(() => expect(result.current.unreadCount).toBe(2));

    const offline = new TypeError("Failed to fetch");
    client.inbox.markRead.mockRejectedValueOnce(offline);
    // the server still has both unread
    client.inbox.unreadCount.mockResolvedValueOnce(count(2));

    await act(async () => {
      await expect(result.current.markRead("n1")).rejects.toBe(offline);
    });
    expect(client.inbox.unreadCount).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(result.current.unreadCount).toBe(2));
  });

  it("rolls back the row when the markRead POST fails", async () => {
    const client = makeMockClient();
    const { result } = renderHook(() => useInbox(client, { pollInterval: 0 }));
    await waitFor(() => expect(result.current.unreadCount).toBe(2));

    client.inbox.markRead.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    // the server still has both unread
    client.inbox.unreadCount.mockResolvedValueOnce(count(2));

    await act(async () => {
      await expect(result.current.markRead("n1")).rejects.toThrow(
        "Failed to fetch",
      );
    });
    expect(
      result.current.notifications.find((n) => n.id === "n1")?.read,
    ).toBe(false);
    await waitFor(() => expect(result.current.unreadCount).toBe(2));
  });

  // The list was computed before the write, so it still has n1 unread. Once the
  // write has failed, nothing should patch n1 read.
  it("does not patch a row read for a list that started before a failed markRead", async () => {
    const client = makeMockClient([makeNotification("n1"), makeNotification("n2")]);
    const { result } = renderHook(() => useInbox(client, { pollInterval: 0 }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const staleList = deferred<ListResponse>();
    client.inbox.list.mockImplementationOnce(() => staleList.promise);
    const refreshing = result.current.refresh();

    client.inbox.markRead.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await act(async () => {
      await expect(result.current.markRead("n1")).rejects.toThrow(
        "Failed to fetch",
      );
    });

    await act(async () =>
      staleList.resolve({
        data: {
          notifications: [makeNotification("n1"), makeNotification("n2")],
          hasMore: false,
        },
        error: null,
      }),
    );
    await act(() => refreshing);

    const byId = Object.fromEntries(
      result.current.notifications.map((n) => [n.id, n.read]),
    );
    expect(byId).toEqual({ n1: false, n2: false });
  });

  // An overlapping write that succeeded owns the row. Its read must survive an
  // earlier write on the same id failing after it.
  it("keeps a row read when an overlapping markRead on it succeeds after an earlier one fails", async () => {
    const client = makeMockClient([makeNotification("n1"), makeNotification("n2")]);
    const { result } = renderHook(() => useInbox(client, { pollInterval: 0 }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let failFirst!: (reason: unknown) => void;
    const post2 = deferred<{ data: unknown; error: null }>();
    client.inbox.markRead
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            failFirst = reject;
          }),
      )
      .mockImplementationOnce(() => post2.promise);

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.markRead("n1");
    });
    act(() => {
      second = result.current.markRead("n1");
    });
    const firstRejected = expect(first).rejects.toThrow("Failed to fetch");

    await act(async () => {
      failFirst(new TypeError("Failed to fetch"));
      await firstRejected;
    });
    await act(async () => post2.resolve({ data: {}, error: null }));
    await act(() => second);

    expect(
      result.current.notifications.find((n) => n.id === "n1")?.read,
    ).toBe(true);
  });

  // A failed revalidation was never retried, so the badge kept the optimistic
  // count until a panel open or a visibility change.
  it("retries a failed count revalidation and lands on the server's count", async () => {
    vi.useFakeTimers();
    try {
      const client = makeMockClient();
      const { result } = renderHook(() => useInbox(client, { pollInterval: 0 }));
      await advance(0);
      expect(result.current.unreadCount).toBe(2);

      // the server reads 0, not the optimistic 1: another tab read n2 too
      client.inbox.unreadCount
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockResolvedValueOnce(count(0));
      await act(async () => {
        await result.current.markRead("n1");
      });
      await advance(0);
      expect(client.inbox.unreadCount).toHaveBeenCalledTimes(2);
      expect(result.current.unreadCount).toBe(1);

      await advance(1_000);
      expect(client.inbox.unreadCount).toHaveBeenCalledTimes(3);
      expect(result.current.unreadCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a pending count retry when a newer write starts", async () => {
    vi.useFakeTimers();
    try {
      const client = makeMockClient();
      const { result } = renderHook(() => useInbox(client, { pollInterval: 0 }));
      await advance(0);

      client.inbox.unreadCount.mockRejectedValueOnce(
        new TypeError("Failed to fetch"),
      );
      await act(async () => {
        await result.current.markRead("n1");
      });
      await advance(0);
      expect(client.inbox.unreadCount).toHaveBeenCalledTimes(2);

      // the newer write's own revalidation takes over, and it reads 0
      client.inbox.unreadCount.mockResolvedValueOnce(count(0));
      await act(async () => {
        await result.current.markRead("n2");
      });
      await advance(10_000);
      expect(client.inbox.unreadCount).toHaveBeenCalledTimes(3);
      expect(result.current.unreadCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a pending count retry on unmount", async () => {
    vi.useFakeTimers();
    try {
      const client = makeMockClient();
      const { result, unmount } = renderHook(() =>
        useInbox(client, { pollInterval: 0 }),
      );
      await advance(0);

      client.inbox.unreadCount.mockRejectedValueOnce(
        new TypeError("Failed to fetch"),
      );
      await act(async () => {
        await result.current.markRead("n1");
      });
      await advance(0);
      expect(client.inbox.unreadCount).toHaveBeenCalledTimes(2);

      unmount();
      await advance(10_000);
      expect(client.inbox.unreadCount).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["transport", "error response"])(
    "retries three times after a %s failure, then reports it",
    async (kind) => {
      vi.useFakeTimers();
      try {
        const client = makeMockClient();
        const { result } = renderHook(() =>
          useInbox(client, { pollInterval: 0 }),
        );
        await advance(0);

        const failure =
          kind === "transport" ? new TypeError("Failed to fetch") : { status: 500 };
        client.inbox.unreadCount.mockImplementation(() =>
          kind === "transport"
            ? Promise.reject(failure)
            : Promise.resolve({ data: null, error: failure }),
        );
        await act(async () => {
          await result.current.markRead("n1");
        });

        // the first attempt, then retries at 1s, 2s and 4s
        await advance(6_999);
        expect(client.inbox.unreadCount).toHaveBeenCalledTimes(4);
        expect(result.current.error).toBeNull();

        await advance(1);
        expect(client.inbox.unreadCount).toHaveBeenCalledTimes(5);
        expect(result.current.error).toBe(failure);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  // Under the unread filter, a markRead that commits while a loadMore page is in
  // flight shifts the server's unread set. The page then starts one row too far
  // along and the row in between is never shown.
  it("refetches a loadMore page that a markRead shifted, so no unread row is skipped", async () => {
    let unread = ["n1", "n2", "n3", "n4", "n5"];
    const pageAt = (offset: number) => ({
      data: {
        notifications: unread
          .slice(offset, offset + 2)
          .map((id) => makeNotification(id)),
        hasMore: offset + 2 < unread.length,
      },
      error: null,
    });
    const client = makeMockClient();
    client.inbox.list.mockImplementation(async ({ query }) =>
      pageAt(query.offset ?? 0),
    );
    client.inbox.unreadCount.mockImplementation(async () =>
      count(unread.length),
    );
    client.inbox.markRead.mockImplementation(async ({ id }) => {
      unread = unread.filter((x) => x !== id);
      return { data: {}, error: null };
    });

    const { result } = renderHook(() =>
      useInbox(client, { filter: "unread", pageSize: 2, pollInterval: 0 }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.notifications.map((n) => n.id)).toEqual(["n1", "n2"]);

    // the loadMore request is computed by the server once it is released
    const release = deferred<void>();
    client.inbox.list.mockImplementationOnce(async ({ query }) => {
      await release.promise;
      return pageAt(query.offset ?? 0);
    });
    let more!: Promise<void>;
    act(() => {
      more = result.current.loadMore();
    });
    await act(async () => {
      await result.current.markRead("n1");
    });
    await act(async () => {
      release.resolve();
      await more;
    });

    // the first response started at n4; the refetch starts at n3 (offset 1)
    expect(client.inbox.list).toHaveBeenLastCalledWith({
      query: { limit: 2, offset: 1, filter: "unread" },
    });
    await waitFor(() =>
      expect(result.current.notifications.map((n) => n.id)).toEqual([
        "n1",
        "n2",
        "n3",
        "n4",
      ]),
    );
  });
});

type CountResponse = { data: { count: number }; error: null };
type ListResponse = {
  data: { notifications: ReturnType<typeof makeNotification>[]; hasMore: boolean };
  error: null;
};

function count(n: number): CountResponse {
  return { data: { count: n }, error: null };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
