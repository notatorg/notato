import { pinNumber } from "@notato/core";
import type { Annotation } from "@notato/schema";
import { useState } from "react";
import { assetHref } from "./api.ts";
import { Icon, useEscape } from "./ui.tsx";

const FULL_ALT = "The page, with the target outlined";

/**
 * A note's screenshots: the page with its pin's number on paper, and the close-up beside it when there is one. Either
 * opens the page full size over everything, until Escape or a click closes it.
 */
export function Screenshots({ annotation: a }: { annotation: Annotation }) {
    const [zoom, setZoom] = useState(false);
    useEscape(() => setZoom(false), zoom);
    const shots = a.screenshots;
    if (!shots) return null;
    const pin = pinNumber(a);

    return (
        <>
            <div className={shots.crop ? "shots two" : "shots"}>
                <button
                    type="button"
                    className="shot"
                    onClick={() => setZoom(true)}
                    aria-label="Enlarge the screenshot"
                >
                    <img src={assetHref(shots.full.id)} alt={FULL_ALT} loading="lazy" />
                    {pin ? (
                        <span className="paper-tag" aria-hidden="true">
                            #{pin}
                        </span>
                    ) : null}
                    <span className="shot-route">{a.route}</span>
                </button>
                {shots.crop ? (
                    <button
                        type="button"
                        className="shot crop"
                        onClick={() => setZoom(true)}
                        aria-label="Enlarge"
                    >
                        <img
                            src={assetHref(shots.crop.id)}
                            alt="Close-up of the target"
                            loading="lazy"
                        />
                    </button>
                ) : null}
            </div>

            {zoom ? (
                <dialog className="lightbox" open aria-label="Screenshot">
                    <button
                        type="button"
                        className="shade"
                        aria-label="Close"
                        onClick={() => setZoom(false)}
                    />
                    <img className="lightbox-img" src={assetHref(shots.full.id)} alt={FULL_ALT} />
                    <button
                        type="button"
                        className="icon-button lightbox-close"
                        aria-label="Close"
                        onClick={() => setZoom(false)}
                    >
                        <Icon name="close" />
                    </button>
                </dialog>
            ) : null}
        </>
    );
}
