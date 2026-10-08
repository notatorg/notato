/**
 * A stand-in for React Native's XMLHttpRequest, for the client's tests: the test answers each request at once
 * (`answer`), or streams to it as a server streams events (`stream`, `end`).
 */
export class FakeXHR {
    static made: FakeXHR[] = [];
    static answer?: (req: FakeXHR) => { status: number; text: string } | undefined;

    method = "";
    url = "";
    headers: Record<string, string> = {};
    status = 0;
    responseText = "";
    timeout = 0;
    aborted = false;
    onload?: () => void;
    onerror?: () => void;
    onabort?: () => void;
    onprogress?: () => void;
    ontimeout?: () => void;

    open(method: string, url: string) {
        this.method = method;
        this.url = url;
    }

    setRequestHeader(name: string, value: string) {
        this.headers[name] = value;
    }

    send() {
        FakeXHR.made.push(this);
        const reply = FakeXHR.answer?.(this);
        if (reply)
            queueMicrotask(() => {
                this.status = reply.status;
                this.responseText = reply.text;
                this.onload?.();
            });
    }

    abort() {
        this.aborted = true;
        this.onabort?.();
    }

    /** More of an event stream arrives. */
    stream(text: string, status = 200) {
        this.status = status;
        this.responseText += text;
        this.onprogress?.();
    }

    /** The server ends the response. */
    end() {
        this.onload?.();
    }

    static install() {
        FakeXHR.made = [];
        FakeXHR.answer = undefined;
        const real = (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
        (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = FakeXHR;
        return () => {
            (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = real;
        };
    }
}
