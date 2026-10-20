// The docs pages: coloured code with a copy button on each block, and the outline following the reader down the page.

import { highlight } from "./highlight.js";

for (const code of document.querySelectorAll(".doc pre.code code")) {
    highlight(code);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "code-copy";
    button.textContent = "Copy";
    button.addEventListener("click", async () => {
        let ok = false;
        try {
            await navigator.clipboard.writeText(code.textContent);
            ok = true;
        } catch {
            // Some views refuse the clipboard: select the code instead, so a keyboard copy works.
            getSelection()?.selectAllChildren(code);
        }
        button.textContent = ok ? "Copied" : "Selected";
        button.classList.toggle("copied", ok);
        setTimeout(() => {
            button.textContent = "Copy";
            button.classList.remove("copied");
        }, 1500);
    });
    code.parentElement.append(button);
}

// The outline marks the section being read: the last heading that has scrolled past the top.
const links = [...document.querySelectorAll(".docs-toc a")];
const sections = links
    .map((link) => document.getElementById(decodeURIComponent(link.hash.slice(1))))
    .filter((heading) => heading);
const mark = () => {
    let current = sections[0];
    for (const heading of sections)
        if (heading.getBoundingClientRect().top < 140) current = heading;
    for (const link of links) link.classList.toggle("on", link.hash === `#${current?.id}`);
};
if (sections.length) {
    addEventListener("scroll", mark, { passive: true });
    mark();
}
