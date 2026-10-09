/**
 * Work for the next frame, in two halves: `read` measures the page (rects, sizes) and `write` changes what is drawn
 * from what was measured. Kept apart so a frame never measures after something was changed, which would make the
 * browser lay the page out again then and there.
 */
export interface FrameJob {
    read?(): void;
    write?(): void;
}

export interface Frames {
    /** Runs the job at the next frame, once however many times it is asked for before then. */
    schedule(job: FrameJob): void;
    /** Takes a job back that has not run yet. */
    cancel(job: FrameJob): void;
    destroy(): void;
}

/**
 * One frame for everything drawn over the page. A scroll moves the pins, the versions switchers, the popover and the
 * picker's outlines at once: each of them alone would measure and then write, and the next one's measuring would lay
 * the page out again. Here every job's reads run first and then every job's writes, so the page is laid out once a
 * frame however many things follow it. A job asked for while the writes run (one thing moved, so another must) waits
 * for the frame after.
 */
export function createFrames(): Frames {
    let jobs = new Set<FrameJob>();
    let frame = 0;

    /** One job failing must not cost the others their frame: it is reported the way an uncaught error would be. */
    const safely = (step: (() => void) | undefined) => {
        try {
            step?.();
        } catch (error) {
            if (typeof reportError === "function") reportError(error);
            else
                setTimeout(() => {
                    throw error;
                });
        }
    };
    const run = () => {
        frame = 0;
        const now = jobs;
        jobs = new Set();
        for (const job of now) safely(job.read?.bind(job));
        for (const job of now) safely(job.write?.bind(job));
    };

    return {
        schedule(job) {
            jobs.add(job);
            if (!frame) frame = requestAnimationFrame(run);
        },
        cancel(job) {
            jobs.delete(job);
            if (jobs.size === 0 && frame) {
                cancelAnimationFrame(frame);
                frame = 0;
            }
        },
        destroy() {
            jobs.clear();
            if (frame) cancelAnimationFrame(frame);
            frame = 0;
        },
    };
}
