// What a note is being written about, made the moment it is picked: the composer opens on it at once, while its
// screenshots are taken behind it. Kept apart from the overlay so it can be tested without React Native.
import type { Picked } from "../inspect.ts";
import { type RawShot, readShot, type Shot } from "../png.ts";
import type { TreeElement } from "../tree.ts";
import { type Point, type Rect, toRect } from "./rect.ts";

/** A note's screenshots as view-shot gave them, not read yet. */
export interface RawShots {
    full?: RawShot;
    crop?: RawShot;
}

/** A note's screenshots, read: what is sent. */
export interface Shots {
    full?: Shot;
    crop?: Shot;
}

/** The element a note is being written about, with its pin, its screenshots on their way and what it is called. */
export interface Selection {
    picked: Picked;
    rect: Rect;
    pin: number;
    id: string;
    /** Never rejects: screenshots that could not be taken are left out, and the note goes without them. */
    shots: Promise<RawShots>;
    title: string;
    subtitle?: string;
}

/** What a selection is called in the composer: the component and the view, then where it is and what it says. */
export function titleOf(element: TreeElement): { title: string; subtitle?: string } {
    const component = element.path[element.path.length - 1];
    const title = component ? `${component} › ${element.tag}` : element.tag;
    const said = element.testId
        ? `#${element.testId}`
        : element.text
          ? `“${element.text.slice(0, 40)}”`
          : element.label;
    const where = element.path.slice(0, -1).slice(-3).join(" › ");
    const subtitle = [said, where].filter(Boolean).join(" · ");
    return subtitle ? { title, subtitle } : { title };
}

/**
 * Makes a picked element the selection, without waiting for its screenshots: they are started here and awaited only
 * when the note is sent. Picking another element while writing (`keep`) keeps the note's pin and id.
 */
export function selectionFor(
    picked: Picked,
    keep: Selection | null | undefined,
    how: {
        /** Where the overlay is on the page. */
        origin: Point;
        nextPin(): number;
        newId(): string;
        shoot(pin: number, id: string): Promise<RawShots>;
    }
): Selection {
    const pin = keep?.pin ?? how.nextPin();
    const id = keep?.id ?? how.newId();
    let shots: Promise<RawShots>;
    try {
        shots = how.shoot(pin, id).catch(() => ({}));
    } catch {
        shots = Promise.resolve({});
    }
    return {
        picked,
        rect: toRect(picked.frame, how.origin),
        pin,
        id,
        shots,
        ...titleOf(picked.element),
    };
}

/** The screenshots a note is sent with: those taken for it, waited for and read only now. */
export async function shotsToSend(selection: Selection): Promise<Shots> {
    return readShots(await selection.shots.catch((): RawShots => ({})));
}

/** Screenshots read: the crop goes only with the full one. */
export function readShots(raw: RawShots): Shots {
    const full = readShot(raw.full);
    const crop = full ? readShot(raw.crop) : undefined;
    return { ...(full ? { full } : {}), ...(crop ? { crop } : {}) };
}
