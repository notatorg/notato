import { expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { NotFound } from "../src/NotFound.tsx";

it("offers real navigation with decorative potatoes hidden from assistive technology", () => {
    const html = renderToStaticMarkup(<NotFound standalone />);
    expect(html).toContain("Page not found.");
    expect(html).toContain("404");
    expect(html).toContain('href="/#/"');
    expect(html).toContain("Back to projects");
    expect(html).toContain("Go back");
    expect(html).toContain('class="not-found-patch" aria-hidden="true"');
    expect(html).not.toContain('alt="potato"');
    expect(html).toContain('<main class="not-found not-found-standalone"');
});

it("keeps missing-note recovery within its project without trusting text as markup", () => {
    const html = renderToStaticMarkup(
        <NotFound
            title="Note not found."
            description={"A link containing <script> is still just text."}
            homeHref="#/p/checkout"
            homeLabel="Back to project"
        />
    );
    expect(html).toContain("Note not found.");
    expect(html).toContain('href="#/p/checkout"');
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<main");
});
