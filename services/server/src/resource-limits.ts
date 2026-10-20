import { z } from "zod";
import type { HostedLimits } from "./storage.ts";

const limit = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional();
const Limits = z
    .object({
        notes: limit,
        bytes: limit,
        projects: limit,
        workspaces: limit,
        tokens: limit,
        members: limit,
        invitations: limit,
        jsonBytes: limit,
        notesPerMonth: limit,
    })
    .strict();

/** Operator capacity controls are independent of subscriptions and feature availability. */
export function resourceLimitsFromEnv(
    env: Record<string, string | undefined> = process.env
): HostedLimits | undefined {
    const value = env.NOTATO_RESOURCE_LIMITS;
    if (!value) return undefined;
    let parsed: z.infer<typeof Limits>;
    try {
        if (value.length > 4096) throw new Error("too large");
        parsed = Limits.parse(JSON.parse(value));
    } catch {
        throw new Error(
            "NOTATO_RESOURCE_LIMITS must be a JSON object of non-negative integer capacity limits"
        );
    }
    const unlimited = Number.MAX_SAFE_INTEGER;
    return {
        notes: unlimited,
        bytes: unlimited,
        projects: unlimited,
        workspaces: unlimited,
        tokens: unlimited,
        members: unlimited,
        invitations: unlimited,
        jsonBytes: unlimited,
        ...parsed,
    };
}
