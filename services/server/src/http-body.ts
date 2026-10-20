import { RequestError } from "@notato/server";

/** The body as text, refusing anything over `limit` bytes without buffering the rest. */
export async function boundedText(req: Request, limit: number): Promise<string> {
    const reader = req.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        if (reader)
            for (;;) {
                const chunk = await reader.read();
                if (chunk.done) break;
                size += chunk.value.length;
                if (size > limit) {
                    await reader.cancel();
                    throw new RequestError("request is too large", 413);
                }
                chunks.push(chunk.value);
            }
    } finally {
        reader?.releaseLock();
    }
    return Buffer.concat(chunks).toString("utf8");
}
