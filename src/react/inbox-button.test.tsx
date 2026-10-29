// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installFakeIntersectionObserver } from "./fake-intersection-observer";
import { InboxButton } from "./inbox-button";
import type { InboxFetchClient } from "./use-inbox";

function makeMockClient(
  notifications = [
    {
      id: "n1",
      userId: "u1",
      type: "test",
      title: "First notification",
      read: false,
      createdAt: new Date().toISOString(),
    },
    {
      id: "n2",
      userId: "u1",
      type: "test",
      title: "Second notification",
      read: false,
      createdAt: new Date().toISOString(),
    },
  ],
): InboxFetchClient {
  return {
    inbox: {
      list: vi.fn().mockResolvedValue({
        data: { notifications, hasMore: false },
        error: null,
      }),
      unreadCount: vi
        .fn()
        .mockResolvedValue({ data: { count: 2 }, error: null }),
      markRead: vi.fn().mockResolvedValue({ data: {}, error: null }),
      markAllRead: vi
        .fn()
        .mockResolvedValue({ data: { count: 2 }, error: null }),
      markSeen: vi.fn().mockResolvedValue({ data: { count: 0 }, error: null }),
    },
  };
}

describe("InboxButton", () => {
  // vitest runs without globals, so RTL never auto-cleans between tests
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows the unread badge, opens the panel, and marks all read", async () => {
    const client = makeMockClient();
    render(<InboxButton client={client} />);

    await waitFor(() => expect(screen.getByText("2")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /notifications/i }));
    await waitFor(() =>
      expect(screen.getByText("First notification")).toBeTruthy(),
    );
    expect(screen.getByText("Second notification")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /mark all read/i }));
    expect(client.inbox.markAllRead).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText("2")).toBeNull());
  });

  // A parent re-rendering — a new inline onNavigate, a client object rebuilt
  // each render — must not refetch; only a scope change should (#5).
  it("does not refetch when the parent re-renders", async () => {
    const client = makeMockClient();
    const { rerender } = render(
      <InboxButton client={{ ...client }} onNavigate={() => {}} />,
    );
    await waitFor(() => expect(screen.getByText("2")).toBeTruthy());

    for (let i = 0; i < 10; i++) {
      rerender(<InboxButton client={{ ...client }} onNavigate={() => {}} />);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(client.inbox.list).toHaveBeenCalledTimes(1);
    expect(client.inbox.unreadCount).toHaveBeenCalledTimes(1);
  });

  // Opening the bell is a deliberate look: it must show what arrived since
  // mount, even seconds later, not skip as fresh (0.4.0 regression).
  it("refetches when the panel opens right after mount", async () => {
    const client = makeMockClient();
    render(<InboxButton client={client} />);
    await waitFor(() => expect(screen.getByText("2")).toBeTruthy());
    expect(client.inbox.list).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /notifications/i }));
    await waitFor(() => expect(client.inbox.list).toHaveBeenCalledTimes(2));
  });

  it("fetches only unread rows and drops the tabs when filtered", async () => {
    const client = makeMockClient();
    render(<InboxButton client={client} filter="unread" />);

    fireEvent.click(screen.getByRole("button", { name: /notifications/i }));
    await waitFor(() =>
      expect(screen.getByText("First notification")).toBeTruthy(),
    );

    expect(client.inbox.list).toHaveBeenCalledWith({
      query: { limit: 20, offset: 0, filter: "unread" },
    });
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
  });

  it("marks an unread row seen once it is on screen in the open panel, and only once", async () => {
    const io = installFakeIntersectionObserver();
    const markSeen = vi.fn().mockResolvedValue({ data: { count: 1 }, error: null });
    const base = makeMockClient([
      {
        id: "n1",
        userId: "u1",
        type: "test",
        title: "Unseen",
        read: false,
        createdAt: new Date().toISOString(),
      },
      {
        id: "n2",
        userId: "u1",
        type: "test",
        title: "Already read",
        read: true,
        createdAt: new Date().toISOString(),
      },
    ]);
    const client = { inbox: { ...base.inbox, markSeen } };
    render(<InboxButton client={client} />);

    // the hook loads the list on mount, but nobody has looked at it yet
    await waitFor(() => expect(base.inbox.list).toHaveBeenCalled());
    expect(markSeen).not.toHaveBeenCalled();

    const bell = screen.getByRole("button", { name: /notifications/i });
    fireEvent.click(bell);
    await waitFor(() => expect(screen.getByText("Unseen")).toBeTruthy());
    const unseen = screen.getByText("Unseen").closest("li") as Element;
    const read = screen.getByText("Already read").closest("li") as Element;
    // rendered is not shown: a row below the scroll stays unseen
    expect(io.observed()).toEqual([unseen]);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(markSeen).not.toHaveBeenCalled();

    io.show([unseen, read]);
    await waitFor(() => expect(markSeen).toHaveBeenCalledWith({ ids: ["n1"] }), {
      timeout: 2000,
    });

    fireEvent.click(bell);
    fireEvent.click(bell);
    await waitFor(() => expect(screen.getByText("Unseen")).toBeTruthy());
    // the reopened panel refetched the row without seenAt; it is not sent again
    io.show([screen.getByText("Unseen").closest("li") as Element]);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(markSeen).toHaveBeenCalledTimes(1);
  });

  it("opens on the unread tab, first, and fetches unread rows", async () => {
    const client = makeMockClient();
    render(<InboxButton client={client} />);

    fireEvent.click(screen.getByRole("button", { name: /notifications/i }));
    await waitFor(() =>
      expect(screen.getByText("First notification")).toBeTruthy(),
    );

    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([
      "Unread",
      "All",
    ]);
    expect(
      screen
        .getByRole("tab", { name: /unread/i })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(client.inbox.list).toHaveBeenCalledWith({
      query: { limit: 20, offset: 0, filter: "unread" },
    });
  });

  it("renders labels in place of the English strings", async () => {
    const client = makeMockClient();
    render(
      <InboxButton
        client={client}
        labels={{
          notifications: "Benachrichtigungen",
          unread: "Ungelesen",
          all: "Alle",
          markAllRead: "Alle gelesen",
          relativeTime: () => "gerade eben",
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Benachrichtigungen" }));
    await waitFor(() =>
      expect(screen.getByText("First notification")).toBeTruthy(),
    );
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([
      "Ungelesen",
      "Alle",
    ]);
    expect(screen.getByRole("button", { name: "Alle gelesen" })).toBeTruthy();
    expect(screen.getAllByText("gerade eben")).toHaveLength(2);
  });

  it("announces the unread count without changing the bell's name", async () => {
    const client = makeMockClient();
    render(<InboxButton client={client} />);

    await waitFor(() =>
      expect(screen.getByText("2 unread notifications")).toBeTruthy(),
    );
    const live = screen.getByText("2 unread notifications");
    expect(live.getAttribute("aria-live")).toBe("polite");
    const bell = screen.getByRole("button", { name: "Notifications" });
    expect(bell.getAttribute("aria-describedby")).toBe(live.id);
  });

  it("returns focus to the bell when Escape closes the panel", async () => {
    const client = makeMockClient();
    render(<InboxButton client={client} labels={{ badge: (n) => `${n}!` }} />);
    await waitFor(() => expect(screen.getByText("2!")).toBeTruthy());

    const bell = screen.getByRole("button", { name: "Notifications" });
    fireEvent.click(bell);
    await waitFor(() =>
      expect(screen.getByText("First notification")).toBeTruthy(),
    );
    screen.getByRole("button", { name: /mark all read/i }).focus();
    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByText("First notification")).toBeNull();
    expect(document.activeElement).toBe(bell);
  });

  it("switching to all refetches without the unread filter", async () => {
    const client = makeMockClient();
    render(<InboxButton client={client} />);

    fireEvent.click(screen.getByRole("button", { name: /notifications/i }));
    await waitFor(() =>
      expect(screen.getByText("First notification")).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole("tab", { name: /all/i }));

    await waitFor(() =>
      expect(client.inbox.list).toHaveBeenCalledWith({
        query: { limit: 20, offset: 0 },
      }),
    );
    expect(
      screen.getByRole("tab", { name: /all/i }).getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("a controlled unread view does not hide rows the server returned", async () => {
    const client = makeMockClient([
      {
        id: "n1",
        userId: "u1",
        type: "test",
        title: "First notification",
        read: false,
        createdAt: new Date().toISOString(),
      },
      {
        id: "n2",
        userId: "u1",
        type: "test",
        title: "Second notification",
        read: true,
        createdAt: new Date().toISOString(),
      },
    ]);
    render(<InboxButton client={client} />);

    fireEvent.click(screen.getByRole("button", { name: /notifications/i }));
    await waitFor(() =>
      expect(screen.getByText("First notification")).toBeTruthy(),
    );

    expect(screen.getByText("Second notification")).toBeTruthy();
  });

  it("buttonClassName replaces the trigger's default look but keeps it relative", () => {
    const client = makeMockClient();
    render(
      <InboxButton
        client={client}
        className="wrapper-class"
        buttonClassName="size-8 rounded-full"
      />,
    );

    const trigger = screen.getByRole("button", { name: /notifications/i });
    expect(trigger.className).toBe("relative size-8 rounded-full");
    expect(trigger.parentElement?.className).toContain("wrapper-class");
  });

  it("keeps the default trigger look without buttonClassName", () => {
    render(<InboxButton client={makeMockClient()} />);

    const trigger = screen.getByRole("button", { name: /notifications/i });
    expect(trigger.className).toContain("size-9");
  });

  // Opening the panel starts a refresh, and a row click can land while its
  // count is still in flight. That count predates the read, so the badge must
  // not come back when it resolves.
  it("keeps the badge at the read count when a panel-open refresh lands after a row click", async () => {
    const client = makeMockClient();
    render(<InboxButton client={client} />);
    await waitFor(() => expect(screen.getByText("2")).toBeTruthy());

    let resolveStale!: (v: { data: { count: number }; error: null }) => void;
    vi.mocked(client.inbox.unreadCount)
      .mockImplementationOnce(
        () => new Promise((resolve) => (resolveStale = resolve)),
      )
      // the revalidation after the POST sees the read
      .mockResolvedValueOnce({ data: { count: 1 }, error: null });

    const bell = screen.getByRole("button", { name: /notifications/i });
    fireEvent.click(bell);
    await waitFor(() =>
      expect(client.inbox.unreadCount).toHaveBeenCalledTimes(2),
    );
    fireEvent.click(screen.getByText("First notification"));
    await waitFor(() => expect(bell.textContent).toBe("1"));
    expect(client.inbox.markRead).toHaveBeenCalledWith({ id: "n1" });

    await act(async () => resolveStale({ data: { count: 2 }, error: null }));
    expect(bell.textContent).toBe("1");
  });

  // Offline: the transport rejects instead of resolving to { error }. The panel
  // fires these without awaiting, so each rejection must be caught there, not
  // surface as an unhandled rejection in the app.
  it("catches rejected writes and Load more without an unhandled rejection", async () => {
    const client = makeMockClient();
    const offline = new TypeError("fetch failed");
    vi.mocked(client.inbox.markRead).mockRejectedValue(offline);
    vi.mocked(client.inbox.markAllRead).mockRejectedValue(offline);
    vi.mocked(client.inbox.list).mockImplementation(async ({ query }) => {
      // the first page and the panel-open refresh are offset 0; Load more is not
      if (query.offset) throw offline;
      return {
        data: {
          notifications: [
            {
              id: "n1",
              userId: "u1",
              type: "test",
              title: "First notification",
              href: "/notifications/n1",
              read: false,
              createdAt: new Date().toISOString(),
            },
          ],
          hasMore: true,
        },
        error: null,
      };
    });
    const onNavigate = vi.fn();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    window.addEventListener("unhandledrejection", unhandled);
    try {
      render(<InboxButton client={client} onNavigate={onNavigate} />);
      await waitFor(() => expect(screen.getByText("2")).toBeTruthy());

      fireEvent.click(screen.getByRole("button", { name: /notifications/i }));
      await waitFor(() =>
        expect(screen.getByText("First notification")).toBeTruthy(),
      );
      // Load more first: it pages by the unread rows held, and Mark all read
      // would leave none, so the offset would fall back to 0
      fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
      await waitFor(() =>
        expect(client.inbox.list).toHaveBeenCalledWith({
          query: { limit: 20, offset: 1, filter: "unread" },
        }),
      );
      fireEvent.click(screen.getByText("First notification"));
      fireEvent.click(screen.getByRole("button", { name: /mark all read/i }));

      expect(client.inbox.markRead).toHaveBeenCalledWith({ id: "n1" });
      expect(client.inbox.markAllRead).toHaveBeenCalled();
      // navigation is not held up by the failed write
      expect(onNavigate).toHaveBeenCalledWith("/notifications/n1");

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.removeListener("unhandledRejection", unhandled);
      window.removeEventListener("unhandledrejection", unhandled);
    }
  });
});
