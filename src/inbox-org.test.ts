import { describe, expect, it } from "vitest";
import {
  createTestAuth,
  createTestAuthWithOrg,
  signUpUser,
} from "./test-utils";

async function setupOrg() {
  const auth = createTestAuthWithOrg();
  const alice = await signUpUser(auth, "alice@example.com");
  const bob = await signUpUser(auth, "bob@example.com");
  const carol = await signUpUser(auth, "carol@example.com");

  const org = await auth.api.createOrganization({
    headers: alice.headers,
    body: { name: "Acme", slug: "acme" },
  });
  if (!org) throw new Error("org creation failed");

  await auth.api.addMember({
    body: { userId: bob.user.id, organizationId: org.id, role: "admin" },
  });
  await auth.api.addMember({
    body: { userId: carol.user.id, organizationId: org.id, role: "member" },
  });

  return { auth, alice, bob, carol, org };
}

describe("org fan-out", () => {
  it("creates one notification per member, stamped with organizationId", async () => {
    const { auth, alice, bob, carol, org } = await setupOrg();

    const res = await auth.api.notify({
      body: {
        organizationId: org.id,
        type: "billing.payment_failed",
        title: "Payment failed",
      },
    });
    expect(res.count).toBe(3);

    for (const member of [alice, bob, carol]) {
      const list = await auth.api.listNotifications({
        headers: member.headers,
        query: {},
      });
      expect(list.notifications).toHaveLength(1);
      expect(list.notifications[0]).toMatchObject({
        userId: member.user.id,
        organizationId: org.id,
        type: "billing.payment_failed",
      });
    }
  });

  it("targets only members whose role matches the roles filter", async () => {
    const { auth, alice, bob, carol, org } = await setupOrg();

    const res = await auth.api.notify({
      body: {
        organizationId: org.id,
        roles: ["owner", "admin"],
        type: "billing.payment_failed",
        title: "Admins only",
      },
    });
    expect(res.count).toBe(2); // alice (owner) + bob (admin), not carol (member)

    const carols = await auth.api.listNotifications({
      headers: carol.headers,
      query: {},
    });
    expect(carols.notifications).toHaveLength(0);

    for (const member of [alice, bob]) {
      const list = await auth.api.listNotifications({
        headers: member.headers,
        query: {},
      });
      expect(list.notifications).toHaveLength(1);
    }
  });

  it("matches a stored role list with spaces after the commas", async () => {
    const { auth, bob, carol, org } = await setupOrg();
    // Rows written before better-auth 1.7.16 may hold "admin, owner"; the
    // organization plugin trims new writes only, so write it past the plugin.
    const { adapter } = await auth.$context;
    await adapter.update({
      model: "member",
      where: [
        { field: "organizationId", value: org.id },
        { field: "userId", value: bob.user.id },
      ],
      update: { role: "admin, owner" },
    });

    const res = await auth.api.notify({
      body: {
        organizationId: org.id,
        roles: ["owner"],
        type: "billing.payment_failed",
        title: "Owners only",
      },
    });
    expect(res.count).toBe(2); // alice ("owner") + bob ("admin, owner")

    const bobs = await auth.api.listNotifications({
      headers: bob.headers,
      query: {},
    });
    expect(bobs.notifications).toHaveLength(1);
    const carols = await auth.api.listNotifications({
      headers: carol.headers,
      query: {},
    });
    expect(carols.notifications).toHaveLength(0);
  });

  it("errors cleanly on bad addressing", async () => {
    const { auth, org } = await setupOrg();

    // neither userId nor organizationId
    await expect(
      auth.api.notify({ body: { type: "t", title: "x" } }),
    ).rejects.toThrow(/Provide userId, organizationId, or both/);

    // roles / excludeUserIds only make sense with fan-out
    await expect(
      auth.api.notify({
        body: { userId: "u1", roles: ["admin"], type: "t", title: "x" },
      }),
    ).rejects.toThrow(/only apply to organization fan-out/);
    await expect(
      auth.api.notify({
        body: {
          userId: "u1",
          organizationId: org.id,
          excludeUserIds: ["u2"],
          type: "t",
          title: "x",
        },
      }),
    ).rejects.toThrow(/only apply to organization fan-out/);
  });

  it("returns count 0 when roles leave no members", async () => {
    const { auth, org } = await setupOrg();

    const res = await auth.api.notify({
      body: {
        organizationId: org.id,
        roles: ["superadmin"],
        type: "t",
        title: "x",
      },
    });
    expect(res).toEqual({ count: 0, notifications: [] });
  });

  it("throws when the organization has no members at all", async () => {
    const { auth, alice, org } = await setupOrg();
    const ctx = await auth.$context;
    await ctx.adapter.deleteMany({
      model: "member",
      where: [{ field: "organizationId", value: org.id }],
    });

    await expect(
      auth.api.notify({
        body: { organizationId: org.id, type: "t", title: "x" },
      }),
    ).rejects.toThrow(/Organization has no members/);

    const list = await auth.api.listNotifications({
      headers: alice.headers,
      query: {},
    });
    expect(list.notifications).toHaveLength(0);
  });

  it("skips excludeUserIds during fan-out (the actor gets no row)", async () => {
    const { auth, alice, bob, carol, org } = await setupOrg();

    const res = await auth.api.notify({
      body: {
        organizationId: org.id,
        excludeUserIds: [alice.user.id],
        type: "comment.added",
        title: "New comment",
      },
    });
    expect(res.count).toBe(2);

    const aliceList = await auth.api.listNotifications({
      headers: alice.headers,
      query: {},
    });
    expect(aliceList.notifications).toHaveLength(0);

    for (const member of [bob, carol]) {
      const list = await auth.api.listNotifications({
        headers: member.headers,
        query: {},
      });
      expect(list.notifications).toHaveLength(1);
    }
  });

  it("returns count 0 when roles and excludeUserIds leave nobody", async () => {
    const { auth, alice, org } = await setupOrg();

    const res = await auth.api.notify({
      body: {
        organizationId: org.id,
        roles: ["owner"],
        excludeUserIds: [alice.user.id],
        type: "t",
        title: "x",
      },
    });
    expect(res).toEqual({ count: 0, notifications: [] });
  });

  it("stamps user + organization as one row, visible through the org filter", async () => {
    const { auth, bob, org } = await setupOrg();

    const res = await auth.api.notify({
      body: {
        userId: bob.user.id,
        organizationId: org.id,
        type: "task.assigned",
        title: "Assigned to you",
      },
    });
    expect(res.count).toBe(1);
    expect(res.notifications[0]).toMatchObject({
      userId: bob.user.id,
      organizationId: org.id,
    });

    const orgOnly = await auth.api.listNotifications({
      headers: bob.headers,
      query: { organizationId: org.id },
    });
    expect(orgOnly.notifications).toHaveLength(1);
    expect(orgOnly.notifications[0]).toMatchObject({
      title: "Assigned to you",
      organizationId: org.id,
    });
  });

  it("refuses userId + organizationId for a non-member and writes no row", async () => {
    const { auth, alice, org } = await setupOrg();
    const dave = await signUpUser(auth, "dave@example.com");

    await expect(
      auth.api.notify({
        body: {
          userId: dave.user.id,
          organizationId: org.id,
          type: "t",
          title: "x",
        },
      }),
    ).rejects.toThrow(/not a member of this organization/);

    const daveList = await auth.api.listNotifications({
      headers: dave.headers,
      query: {},
    });
    expect(daveList.notifications).toHaveLength(0);
    const aliceList = await auth.api.listNotifications({
      headers: alice.headers,
      query: {},
    });
    expect(aliceList.notifications).toHaveLength(0);
  });

  it("refuses userId + organizationId when the organization plugin is missing", async () => {
    const auth = createTestAuth();
    const alice = await signUpUser(auth, "alice@example.com");

    await expect(
      auth.api.notify({
        body: {
          userId: alice.user.id,
          organizationId: "org_1",
          type: "t",
          title: "x",
        },
      }),
    ).rejects.toThrow(/requires the organization plugin/);
  });

  it("refuses fan-out beyond maxFanout and writes zero rows", async () => {
    const auth = createTestAuthWithOrg({ maxFanout: 2 });
    const alice = await signUpUser(auth, "alice@example.com");
    const bob = await signUpUser(auth, "bob@example.com");
    const carol = await signUpUser(auth, "carol@example.com");
    const org = await auth.api.createOrganization({
      headers: alice.headers,
      body: { name: "Acme", slug: "acme" },
    });
    if (!org) throw new Error("org creation failed");
    await auth.api.addMember({
      body: { userId: bob.user.id, organizationId: org.id, role: "member" },
    });
    await auth.api.addMember({
      body: { userId: carol.user.id, organizationId: org.id, role: "member" },
    });

    await expect(
      auth.api.notify({
        body: { organizationId: org.id, type: "t", title: "too many" },
      }),
    ).rejects.toThrow(/maxFanout/);

    for (const member of [alice, bob, carol]) {
      const list = await auth.api.listNotifications({
        headers: member.headers,
        query: {},
      });
      expect(list.notifications).toHaveLength(0);
    }
  });

  it("filters the list by organizationId", async () => {
    const { auth, alice, org } = await setupOrg();

    await auth.api.notify({
      body: { userId: alice.user.id, type: "t", title: "personal" },
    });
    await auth.api.notify({
      body: { organizationId: org.id, type: "t", title: "org-wide" },
    });

    const all = await auth.api.listNotifications({
      headers: alice.headers,
      query: {},
    });
    expect(all.notifications).toHaveLength(2);

    const orgOnly = await auth.api.listNotifications({
      headers: alice.headers,
      query: { organizationId: org.id },
    });
    expect(orgOnly.notifications).toHaveLength(1);
    expect(orgOnly.notifications[0]).toMatchObject({
      title: "org-wide",
      organizationId: org.id,
    });
  });
});
