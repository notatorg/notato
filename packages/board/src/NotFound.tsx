import { type CSSProperties, type ReactNode, useEffect, useId, useRef } from "react";
import potato from "./notato.png";

const potatoes = [
    ["8%", "14%", 140, -24],
    ["76%", "6%", 112, 22],
    ["92%", "34%", 166, -18],
    ["4%", "59%", 96, 14],
    ["19%", "88%", 150, -12],
    ["72%", "84%", 126, 28],
    ["47%", "3%", 68, -32],
    ["93%", "78%", 70, 8],
] as const;

/** Shared by the board and the standalone HTTP 404 page. No account or provider calls are needed. */
export function NotFound({
    title = "Page not found.",
    description = "The link may be out of date, or this page may have moved. Let's get you back to your notes.",
    homeHref = "/#/",
    homeLabel = "Back to projects",
    standalone = false,
    children,
}: {
    title?: string;
    description?: string;
    homeHref?: string;
    homeLabel?: string;
    standalone?: boolean;
    children?: ReactNode;
}) {
    const headingId = useId();
    const heading = useRef<HTMLHeadingElement>(null);
    useEffect(() => heading.current?.focus({ preventScroll: true }), []);
    const Container = standalone ? "main" : "section";
    return (
        <Container
            className={`not-found${standalone ? " not-found-standalone" : ""}`}
            aria-labelledby={headingId}
        >
            <div className="not-found-patch" aria-hidden="true">
                {potatoes.map(([x, y, size, tilt], i) => (
                    <img
                        key={x}
                        className="not-found-potato"
                        src={potato}
                        alt=""
                        width={size}
                        height={size}
                        draggable={false}
                        style={
                            {
                                left: x,
                                top: y,
                                width: size,
                                "--tilt": `${tilt}deg`,
                                "--delay": `${i * -1.3}s`,
                            } as CSSProperties
                        }
                    />
                ))}
            </div>
            <div className="not-found-note">
                <p className="not-found-code">404</p>
                <h1 id={headingId} ref={heading} tabIndex={-1}>
                    {title}
                </h1>
                <p className="not-found-pun">We dug around. Nothing here but potatoes.</p>
                <p className="not-found-description">{description}</p>
                <div className="not-found-actions">
                    <a className="button-link primary" href={homeHref}>
                        {homeLabel}
                    </a>
                    <button
                        className="not-found-back"
                        type="button"
                        onClick={() => {
                            if (window.history.length > 1) window.history.back();
                            else window.location.assign(homeHref);
                        }}
                    >
                        Go back
                    </button>
                </div>
                {children ? <div className="not-found-extra">{children}</div> : null}
            </div>
            <span className="not-found-caption" aria-hidden="true">
                a small detour in the potato patch
            </span>
        </Container>
    );
}
