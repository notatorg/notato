export {};

const form = document.querySelector<HTMLFormElement>("form[data-waitlist]");
const status = document.querySelector<HTMLElement>("#waitlist-status");
const fields = form?.querySelector("fieldset");
const button = form?.querySelector("button");
const endpoint = document.body.dataset.waitlistEndpoint;
if (form && status && fields && button) {
    if (!endpoint) {
        form.hidden = true;
        status.hidden = false;
        status.textContent = "Waitlist signups are being prepared. Please check back soon.";
    } else {
        let busy = false;
        form.addEventListener("submit", async (event) => {
            event.preventDefault();
            if (busy) return;
            busy = true;
            const values = Object.fromEntries(new FormData(form));
            fields.disabled = true;
            button.textContent = "Sending…";
            status.hidden = true;
            try {
                const response = await fetch(endpoint, {
                    method: "POST",
                    credentials: "omit",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify(values),
                    signal: AbortSignal.timeout(15_000),
                });
                if (response.status !== 202) {
                    const data = await response.json().catch(() => null);
                    throw new Error(
                        typeof data?.error === "string"
                            ? data.error
                            : "Could not save your request. Please try again shortly."
                    );
                }
                form.hidden = true;
                status.textContent =
                    "You're on the list. Thanks for your interest! We'll contact you when a beta place is available. You don't need to create an account yet.";
            } catch (error) {
                status.textContent =
                    error instanceof Error &&
                    error.name !== "TimeoutError" &&
                    error.name !== "TypeError"
                        ? error.message
                        : "Could not reach the waitlist. Please try again shortly.";
                fields.disabled = false;
                button.textContent = "Join the waitlist";
                busy = false;
            }
            status.hidden = false;
            status.focus();
        });
    }
}
