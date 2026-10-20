import { type ReactNode, type RefObject, useEffect } from "react";

/** Keep saved links working when a page moves to its own scope. */
export function PageRedirect({ to }: { to: string }) {
    useEffect(() => window.location.replace(to), [to]);
    return <p className="center muted">Opening settings…</p>;
}

/** One block of a settings-style page: what it is on the left, its controls and content on the right. */
export function Section({
    title,
    about,
    children,
    sectionRef,
    className,
}: {
    title: ReactNode;
    about?: ReactNode;
    children?: ReactNode;
    sectionRef?: RefObject<HTMLElement | null>;
    className?: string;
}) {
    return (
        <section
            className={className ? `set-section ${className}` : "set-section"}
            ref={sectionRef}
        >
            <div className="set-label">
                <h2>{title}</h2>
                {about ? <p>{about}</p> : null}
            </div>
            <div className="set-body">{children}</div>
        </section>
    );
}

/** The tab's title while a page is open: "Integrations · Notato". The board sets its own for its own pages. */
export function usePageTitle(title: string) {
    useEffect(() => {
        const was = document.title;
        const apply = () => {
            document.title = `${title} · Notato`;
        };
        apply();
        // The board sets its own title as it loads; ours goes on top of that.
        const later = setTimeout(apply, 250);
        return () => {
            clearTimeout(later);
            document.title = was;
        };
    }, [title]);
}

/** A row's less common actions behind one "More" control, so the row stays readable. */
export function RowMenu({ label = "More", children }: { label?: string; children: ReactNode }) {
    return (
        <details
            className="row-menu"
            onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null))
                    e.currentTarget.removeAttribute("open");
            }}
        >
            <summary>{label}</summary>
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: the buttons inside carry the keyboard behaviour */}
            {/* biome-ignore lint/a11y/noStaticElementInteractions: closes the menu once a choice is made */}
            <div
                className="row-menu-items"
                onClick={(e) =>
                    (e.currentTarget.closest("details") as HTMLDetailsElement).removeAttribute(
                        "open"
                    )
                }
            >
                {children}
            </div>
        </details>
    );
}
