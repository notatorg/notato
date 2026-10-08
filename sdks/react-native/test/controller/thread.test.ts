import { Annotation } from "@notato/schema";
import { describe, expect, it } from "vitest";
import { start } from "./harness.ts";

describe("acting on a note", () => {
    it("replies, asides, People only, revert and delete go through the server", async () => {
        const { notato, server } = start({ project: "shop", author: "Ada" });
        await server.hello();
        const a = await notato.annotate("Text", "Note");
        await notato.reply(a.id, "  More detail  ", true);
        expect(server.transport.reply).toHaveBeenCalledWith(
            expect.anything(),
            a.id,
            "More detail",
            { kind: "human", name: "Ada" },
            true
        );
        await notato.setPeopleOnly(a.id, true);
        expect(notato.getState().notes[0]?.annotation.peopleOnly).toBe(true);
        await notato.requestRevert(a.id, "");
        expect(server.transport.setStatus).toHaveBeenCalledWith(
            expect.anything(),
            a.id,
            "revert_requested",
            "Please undo this change.",
            expect.anything()
        );
        await notato.cancelRevert(a.id);
        await notato.delete(a.id);
        expect(server.stored.size).toBe(0);
        expect(notato.getState().notes).toHaveLength(0);
    });

    it("records People only on a note still on the device, in its thread", async () => {
        const { notato } = start({ project: "shop", mode: "test", author: "Tess" });
        const a = await notato.annotate("Text", "x");
        await notato.setPeopleOnly(a.id, true);
        const note = notato.getState().notes[0]?.annotation as Annotation;
        expect(note.peopleOnly).toBe(true);
        expect(note.thread).toMatchObject([
            {
                automatic: true,
                peopleOnly: true,
                author: { name: "Tess" },
                body: "Made this people only: the agent won't see it.",
            },
        ]);
        await notato.setPeopleOnly(a.id, false);
        expect(notato.getState().notes[0]?.annotation.peopleOnly).toBeUndefined();
        expect(Annotation.safeParse(notato.getState().notes[0]?.annotation).success).toBe(true);
    });
});
