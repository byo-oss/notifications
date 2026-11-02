import { defineErrorCodes } from "better-auth";

export const INBOX_ERROR_CODES = defineErrorCodes({
  NOTIFICATION_NOT_FOUND: "Notification not found",
  USER_OR_ORGANIZATION_REQUIRED:
    "Provide userId, organizationId, or both",
  FAN_OUT_OPTIONS_WITHOUT_USER:
    "roles and excludeUserIds only apply to organization fan-out; omit them when sending to a userId",
  ORGANIZATION_PLUGIN_REQUIRED:
    "organizationId requires the organization plugin",
  USER_NOT_IN_ORGANIZATION: "User is not a member of this organization",
  ORGANIZATION_HAS_NO_MEMBERS: "Organization has no members",
  FAN_OUT_LIMIT_EXCEEDED: "Organization member count exceeds maxFanout",
  RESERVED_NOTIFICATION_TYPE:
    'Notification types starting with "notifications." are reserved for the plugin\'s own events',
  PUSH_ENDPOINT_NOT_ALLOWED: "This push endpoint is not allowed",
  PUSH_KEYS_INVALID: "The push subscription keys are not valid",
  PUSH_SUBSCRIPTION_FAILED: "The push subscription could not be saved",
});
