import { expect, it } from "bun:test";
import type { Authenticator } from "../src/auth.ts";
import { aboutCaller } from "../src/routes/account.ts";

it("names administration separately from the caller's permissions", async () => {
    const auth = { managed: undefined } as Authenticator;
    const selfHosted = await aboutCaller(auth, {})(null);
    const cloud = await aboutCaller(auth, { administration: { title: "Platform administration" } })(
        null
    );
    expect(selfHosted.administration).toEqual({ title: "Instance administration" });
    expect(cloud.administration).toEqual({ title: "Platform administration" });
    expect(selfHosted.instanceAdmin).toBe(false);
    expect(cloud.instanceAdmin).toBe(false);
    expect(cloud.isAdmin).toBe(false);
});
