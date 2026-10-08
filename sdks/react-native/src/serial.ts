/**
 * Runs tasks one at a time, in the order they come, and says when the last of them is done. Screenshots are taken
 * this way: one that finishes first must not take the covers off what the next is photographing.
 */
export function serial(idle: () => void): <T>(task: () => Promise<T>) => Promise<T> {
    let tail: Promise<unknown> = Promise.resolve();
    let waiting = 0;
    return <T>(task: () => Promise<T>) => {
        waiting++;
        const run = tail.then(task).finally(() => {
            waiting--;
            if (waiting === 0) idle();
        });
        tail = run.catch(() => undefined);
        return run;
    };
}
