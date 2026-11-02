import type { AuthContext } from "better-auth";
import { chunk } from "../adapter";
import type { PushSubscriptionRow } from "../schema";

/** The channel's view of the `pushSubscription` table. */
export type PushStore = {
  /** Every subscription of a user. */
  list(userId: string): Promise<PushSubscriptionRow[]>;
  /** Deletes rows by id. Best effort: never throws. */
  remove(ids: string[]): Promise<void>;
  /** Records a successful push. Best effort: never throws. */
  touch(id: string, at: Date): Promise<void>;
};

/** More than this per user is never kept; `subscribe` drops the oldest. */
export const MAX_SUBSCRIPTIONS_PER_USER = 20;

const MODEL = "pushSubscription";

/**
 * A store on the auth instance's own adapter. The context arrives in the
 * plugin's `init`, after `inbox()` has built the channel, so it is read lazily.
 *
 * `remove` and `touch` swallow database errors and log a fixed line: the text
 * of a database error can quote the row, and the row's endpoint is a credential.
 */
export function adapterStore(getContext: () => AuthContext | undefined): PushStore {
  const context = () => {
    const current = getContext();
    if (!current) {
      throw new Error(
        "[@byo-oss/notifications] the push channel ran before the inbox plugin was initialized",
      );
    }
    return current;
  };
  return {
    list: (userId) =>
      context().adapter.findMany<PushSubscriptionRow>({
        model: MODEL,
        where: [{ field: "userId", value: userId }],
        limit: 100,
      }),
    async remove(ids) {
      if (ids.length === 0) return;
      const current = context();
      try {
        for (const part of chunk(ids)) {
          await current.adapter.deleteMany({
            model: MODEL,
            where: [{ field: "id", operator: "in", value: part }],
          });
        }
      } catch {
        current.logger.error(
          "[@byo-oss/notifications] could not delete a push subscription",
        );
      }
    },
    async touch(id, at) {
      const current = context();
      try {
        await current.adapter.update({
          model: MODEL,
          where: [{ field: "id", value: id }],
          update: { lastUsedAt: at },
        });
      } catch {
        current.logger.error(
          "[@byo-oss/notifications] could not update a push subscription",
        );
      }
    },
  };
}
