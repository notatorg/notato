// What the games share: a canvas that stays sharp at any size, a frame loop that stops when the tab is hidden,
// synthesised sounds, a best score kept in this browser, the card shown over the scene, and the drawing style
// both games are made of: flat colour inside a dark ink outline, like a sticker.

/** The outline colour of everything in the scenes. */
export const INK = "#23262b";

/** Notato's pin colours, for confetti. */
export const PINS = ["#1f8a78", "#3b82f6", "#8b5cf6", "#ec4899", "#f97316", "#2e9a5b", "#f4c56e"];

export const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

/**
 * A sharp canvas filling `stage`. `size` is in CSS pixels; `begin()` clears it and sets the transform so drawing in
 * CSS pixels comes out sharp. `onResize(fn)` runs when the stage changes size.
 */
export function makeCanvas(stage) {
    const canvas = stage.querySelector("canvas");
    const ctx = canvas.getContext("2d");
    const size = { w: 1, h: 1, dpr: 1 };
    const listeners = [];
    const resize = () => {
        const rect = stage.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        size.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
        size.w = rect.width;
        size.h = rect.height;
        canvas.width = Math.round(rect.width * size.dpr);
        canvas.height = Math.round(rect.height * size.dpr);
        for (const listener of listeners) listener(size);
    };
    new ResizeObserver(resize).observe(stage);
    resize();
    return {
        canvas,
        ctx,
        size,
        onResize: (listener) => listeners.push(listener),
        begin() {
            ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
            ctx.clearRect(0, 0, size.w, size.h);
        },
        /** A pointer event's position on the canvas, in CSS pixels. */
        local(event) {
            const rect = canvas.getBoundingClientRect();
            return { x: event.clientX - rect.left, y: event.clientY - rect.top };
        },
    };
}

/** Calls `frame(dt)` every animation frame, with dt in seconds, capped so a stall does not teleport things. */
export function loop(frame) {
    let last = 0;
    const tick = (now) => {
        const dt = last ? Math.min((now - last) / 1000, 1 / 30) : 0;
        last = now;
        frame(dt);
        requestAnimationFrame(tick);
    };
    document.addEventListener("visibilitychange", () => {
        last = 0;
    });
    requestAnimationFrame(tick);
}

const store = {
    get(key) {
        try {
            return localStorage.getItem(key);
        } catch {
            return null;
        }
    },
    set(key, value) {
        try {
            localStorage.setItem(key, value);
        } catch {
            // Private windows and blocked storage: the game still works, it just forgets.
        }
    },
};

/** The best score for a game, kept in this browser. `offer(score)` returns true when it is a new best. */
export function bestScore(game) {
    const key = `notato.games.${game}.best`;
    let best = Number(store.get(key)) || 0;
    return {
        get value() {
            return best;
        },
        offer(score) {
            if (score <= best) return false;
            best = score;
            store.set(key, String(score));
            return true;
        },
    };
}

/** Synthesised sounds, so the games need no audio files. Silent until the first tap, and mutable. */
export function makeSound(button) {
    const key = "notato.games.muted";
    let muted = store.get(key) === "1";
    let audio;
    let master;
    const icon = () => {
        button.setAttribute("aria-pressed", String(muted));
        button.setAttribute("aria-label", muted ? "Turn sound on" : "Turn sound off");
        button.innerHTML = muted
            ? '<svg class="mute-icon" viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4zM17 9l5 6M22 9l-5 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
            : '<svg class="mute-icon" viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4zM17 8.5a5 5 0 0 1 0 7M19.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    };
    icon();
    button.addEventListener("click", () => {
        muted = !muted;
        store.set(key, muted ? "1" : "0");
        icon();
    });
    const context = () => {
        if (muted) return null;
        if (!audio) {
            const Context = window.AudioContext || window.webkitAudioContext;
            if (!Context) return null;
            audio = new Context();
            master = audio.createDynamicsCompressor();
            master.connect(audio.destination);
        }
        if (audio.state === "suspended") audio.resume();
        return audio;
    };
    /** A tone that slides from `from` to `to` Hz. */
    const tone = (from, to, duration, type = "sine", volume = 0.18, delay = 0) => {
        const ac = context();
        if (!ac) return;
        const start = ac.currentTime + delay;
        const osc = ac.createOscillator();
        const gain = ac.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(from, start);
        osc.frequency.exponentialRampToValueAtTime(Math.max(to, 1), start + duration);
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(volume, start + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
        osc.connect(gain).connect(master);
        osc.start(start);
        osc.stop(start + duration + 0.05);
    };
    /** Filtered noise: thumps, whooshes and splats. `sweep` moves the filter to that frequency as it plays. */
    const noise = (duration, frequency, volume = 0.3, delay = 0, sweep, type = "lowpass") => {
        const ac = context();
        if (!ac) return;
        const start = ac.currentTime + delay;
        const length = Math.max(1, Math.floor(ac.sampleRate * duration));
        const buffer = ac.createBuffer(1, length, ac.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 2;
        const source = ac.createBufferSource();
        source.buffer = buffer;
        const filter = ac.createBiquadFilter();
        filter.type = type;
        filter.frequency.setValueAtTime(frequency, start);
        if (sweep) filter.frequency.exponentialRampToValueAtTime(sweep, start + duration);
        const gain = ac.createGain();
        gain.gain.value = volume;
        source.connect(filter).connect(gain).connect(master);
        source.start(start);
    };
    /** A short rising arpeggio, for a success. */
    const chime = (base = 660, delay = 0, volume = 0.1) => {
        [1, 1.25, 1.5, 2].forEach((ratio, i) => {
            tone(base * ratio, base * ratio * 1.01, 0.22, "triangle", volume, delay + i * 0.06);
        });
    };
    return { tone, noise, chime, unlock: context };
}

/**
 * Shows a card over the scene: an optional picture, a title, a big number, a badge, some lines and a button.
 * Resolves when the button is pressed.
 */
export function showCard(stage, { title, text, big, badge, button, image, kicker, share }) {
    stage.querySelector(".overlay")?.remove();
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    const card = document.createElement("div");
    card.className = "overlay-card";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", title);
    const add = (tag, className, content) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (content !== undefined) node.textContent = content;
        card.append(node);
        return node;
    };
    if (image) {
        const img = add("img", "card-art");
        img.src = image;
        img.alt = "";
        img.width = 84;
        img.height = 84;
    }
    if (kicker) add("p", "kicker", kicker);
    add("h2", "", title);
    if (big !== undefined) add("p", "big", big);
    if (badge) add("span", "new-best", badge);
    for (const line of [text].flat().filter(Boolean)) add("p", "", line);
    const actions = document.createElement("div");
    actions.className = "card-actions";
    card.append(actions);
    const go = document.createElement("button");
    go.className = "btn btn-tab btn-lg";
    go.textContent = button;
    go.type = "button";
    actions.append(go);
    if (share) actions.append(shareButton(share));
    overlay.append(card);
    stage.append(overlay);
    go.focus({ preventScroll: true });
    return new Promise((resolve) => {
        go.addEventListener("click", () => {
            overlay.classList.add("leaving");
            setTimeout(() => overlay.remove(), 180);
            resolve();
        });
    });
}

/**
 * A button that shares a score: the system share sheet where there is one, otherwise the text and a link on the
 * clipboard. The link is the game's own page, without anything after its path.
 */
function shareButton(text) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn btn-ghost btn-lg";
    button.textContent = "Share";
    const url = `${location.origin}${location.pathname}`;
    button.addEventListener("click", async () => {
        try {
            if (navigator.share) {
                await navigator.share({ text, url });
                return;
            }
            await copy(`${text} ${url}`);
            button.textContent = "Copied!";
        } catch (error) {
            // Closing the share sheet is not a failure; anything else, say so on the button.
            if (error?.name !== "AbortError") button.textContent = "Couldn't share";
        }
        setTimeout(() => {
            button.textContent = "Share";
        }, 1800);
    });
    return button;
}

/** Copies text: the clipboard API where it is allowed, otherwise the older copy command. */
async function copy(text) {
    try {
        await navigator.clipboard.writeText(text);
        return;
    } catch {
        const field = document.createElement("textarea");
        field.value = text;
        field.setAttribute("readonly", "");
        field.style.position = "fixed";
        field.style.opacity = "0";
        document.body.append(field);
        field.select();
        const done = document.execCommand("copy");
        field.remove();
        if (!done) throw new Error("copy refused");
    }
}

/** A short vibration on phones that have one; nothing anywhere else. */
export function buzz(pattern) {
    try {
        navigator.vibrate?.(pattern);
    } catch {
        // Some browsers refuse vibration without a tap first: the game goes on without it.
    }
}

/** Mixes two #rrggbb colours: `t` 0 is `a`, 1 is `b`. */
export function mix(a, b, t) {
    const pa = parseInt(a.slice(1), 16);
    const pb = parseInt(b.slice(1), 16);
    const channel = (shift) =>
        Math.round(lerp((pa >> shift) & 255, (pb >> shift) & 255, clamp(t, 0, 1)));
    return `rgb(${channel(16)}, ${channel(8)}, ${channel(0)})`;
}

/** Says something to screen readers. */
export function announcer(node) {
    return (text) => {
        node.textContent = "";
        requestAnimationFrame(() => {
            node.textContent = text;
        });
    };
}

export const rand = (min, max) => min + Math.random() * (max - min);
export const pick = (list) => list[Math.floor(Math.random() * list.length)];
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
export const lerp = (a, b, t) => a + (b - a) * t;
export const easeOut = (t) => 1 - (1 - t) ** 3;
export const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
/** Overshoots and settles, for things that pop in. */
export const easeBack = (t) => {
    const c = 1.9;
    return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2;
};
/** Moves `current` toward `target` at `rate` per second, the same at any frame rate. */
export const approach = (current, target, rate, dt) =>
    target + (current - target) * Math.exp(-rate * dt);

/** A seeded random number generator, so scenery is the same every time. */
export function seeded(seed) {
    let s = seed >>> 0 || 1;
    return () => {
        s ^= s << 13;
        s ^= s >>> 17;
        s ^= s << 5;
        return ((s >>> 0) % 100000) / 100000;
    };
}

/** Fills the current path, then outlines it in ink. */
export function inked(ctx, fill, width = 3) {
    if (fill) {
        ctx.fillStyle = fill;
        ctx.fill();
    }
    ctx.lineWidth = width;
    ctx.strokeStyle = INK;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();
}

/** A thick line with an ink outline (an arm, a leg, a pole). */
export function inkedLine(ctx, points, color, width, outline = 3) {
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    for (const [i, [x, y]] of points.entries()) {
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
    }
    ctx.strokeStyle = INK;
    ctx.lineWidth = width + outline * 2;
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
}

export function circle(ctx, x, y, r) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
}

export function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
}

/** A potato in the house style: lumpy, outlined, with a highlight and eyes (the potato kind). */
export function drawPotato(ctx, x, y, r, angle = 0, seed = 1, squash = 0) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.scale(1 + squash, 1 - squash);
    const shape = () => {
        ctx.beginPath();
        const points = 18;
        for (let i = 0; i <= points; i++) {
            const a = (i / points) * Math.PI * 2;
            const wobble = 1 + Math.sin(a * 3 + seed) * 0.07 + Math.sin(a * 5 + seed * 2.3) * 0.04;
            const px = Math.cos(a) * r * 1.25 * wobble;
            const py = Math.sin(a) * r * 0.92 * wobble;
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
        }
        ctx.closePath();
    };
    shape();
    inked(ctx, "#d9a05a", Math.max(1.5, r * 0.2));
    ctx.save();
    shape();
    ctx.clip();
    ctx.fillStyle = "#b97a35";
    ctx.beginPath();
    ctx.ellipse(r * 0.25, r * 0.55, r * 1.3, r * 0.55, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = "rgba(255, 240, 205, 0.75)";
    ctx.beginPath();
    ctx.ellipse(-r * 0.45, -r * 0.38, r * 0.42, r * 0.18, -0.35, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#8a5622";
    for (const [ex, ey] of [
        [-0.15, 0.1],
        [0.55, -0.25],
        [0.45, 0.35],
    ]) {
        ctx.beginPath();
        ctx.ellipse(ex * r, ey * r, r * 0.12, r * 0.08, seed, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.restore();
}

/** Potato confetti: chips, crisps and little spuds, with a few sticky notes. Push the result into a particle list. */
export function confetti(x, y, count, spread = 1, up = 1) {
    return Array.from({ length: count }, () => {
        const a = -Math.PI / 2 + rand(-1.1, 1.1) * spread;
        const speed = rand(180, 520);
        return {
            kind: "confetti",
            x,
            y,
            vx: Math.cos(a) * speed,
            vy: Math.sin(a) * speed * up,
            rot: rand(0, Math.PI * 2),
            spin: rand(-12, 12),
            shape: pick(CONFETTI_SHAPES),
            size: rand(0.8, 1.2),
            seed: rand(0, 10),
            color: pick(PINS),
            life: rand(1.2, 2),
            max: 2,
            drag: 1.6,
            gravity: 620,
        };
    });
}

const CONFETTI_SHAPES = ["chip", "chip", "chip", "crisp", "crisp", "spud", "spud", "note"];

/** One piece of confetti at the origin, about 16 units across. */
function drawConfettiPiece(ctx, p) {
    ctx.lineJoin = "round";
    if (p.shape === "chip") {
        // A chip: a gold stick with a browned tip.
        roundRect(ctx, -2.6, -8, 5.2, 16, 1.5);
        inked(ctx, "#f2c14e", 1.4);
        ctx.fillStyle = "#c98b2a";
        ctx.fillRect(-1.9, -7.3, 3.8, 3);
    } else if (p.shape === "crisp") {
        // A crisp: a wavy pale-gold disc with a couple of bubbles.
        ctx.beginPath();
        for (let i = 0; i <= 14; i++) {
            const a = (i / 14) * Math.PI * 2;
            const r = 6.5 + Math.sin(a * 4 + p.seed) * 0.9;
            ctx.lineTo(Math.cos(a) * r * 1.15, Math.sin(a) * r * 0.9);
        }
        ctx.closePath();
        inked(ctx, "#f6d97f", 1.4);
        ctx.fillStyle = "#dca945";
        circle(ctx, -2, -1, 1.3);
        ctx.fill();
        circle(ctx, 2.5, 1.8, 1);
        ctx.fill();
    } else if (p.shape === "spud") {
        drawPotato(ctx, 0, 0, 6.5, 0, p.seed);
    } else {
        // A sticky note in a pin colour, its corner folded.
        ctx.beginPath();
        ctx.moveTo(-5.5, -5.5);
        ctx.lineTo(5.5, -5.5);
        ctx.lineTo(5.5, 2.5);
        ctx.lineTo(2.5, 5.5);
        ctx.lineTo(-5.5, 5.5);
        ctx.closePath();
        inked(ctx, p.color, 1.4);
        ctx.fillStyle = "rgba(255, 255, 255, 0.45)";
        ctx.beginPath();
        ctx.moveTo(5.5, 2.5);
        ctx.lineTo(2.5, 2.5);
        ctx.lineTo(2.5, 5.5);
        ctx.closePath();
        ctx.fill();
    }
}

/** Moves particles on, with gravity and air drag, and drops the dead ones. */
export function stepParticles(list, dt) {
    for (const p of list) {
        p.life -= dt;
        const drag = Math.exp(-(p.drag ?? 0) * dt);
        p.vx *= drag;
        p.vy = p.vy * drag + (p.gravity ?? 0) * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        if (p.spin) p.rot += p.spin * dt;
        if (p.grow) p.r += p.grow * dt;
    }
    return list.filter((p) => p.life > 0);
}

/** Draws particles: confetti, puffs of smoke or dust, and flecks. */
export function drawParticles(ctx, list) {
    for (const p of list) {
        const alpha = clamp(p.life / (p.max ?? 1), 0, 1);
        ctx.globalAlpha = p.kind === "puff" ? alpha * (p.alpha ?? 0.8) : Math.min(1, alpha * 2);
        if (p.kind === "confetti") {
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate(p.rot);
            ctx.scale(Math.cos(p.rot * 1.7) * p.size, p.size);
            drawConfettiPiece(ctx, p);
            ctx.restore();
        } else if (p.kind === "cookie") {
            // A cookie, tumbling: golden, with chocolate chips.
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate(p.rot);
            circle(ctx, 0, 0, p.r);
            inked(ctx, "#d9a05a", Math.max(1.5, p.r * 0.22));
            ctx.fillStyle = "#5b3a1e";
            for (let i = 0; i < 4; i++) {
                const a = p.seed + i * 1.7;
                circle(ctx, Math.cos(a) * p.r * 0.5, Math.sin(a) * p.r * 0.5, p.r * 0.17);
                ctx.fill();
            }
            ctx.restore();
        } else if (p.kind === "chunk") {
            // A broken-off chunk of something: a little outlined shard.
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate(p.rot);
            ctx.beginPath();
            ctx.moveTo(-p.r, -p.r * 0.6);
            ctx.lineTo(p.r * 0.8, -p.r);
            ctx.lineTo(p.r, p.r * 0.5);
            ctx.lineTo(-p.r * 0.4, p.r);
            ctx.closePath();
            inked(ctx, p.color, 2);
            ctx.restore();
        } else if (p.kind === "puff") {
            circle(ctx, p.x, p.y, p.r);
            ctx.fillStyle = p.color;
            ctx.fill();
        } else {
            circle(ctx, p.x, p.y, p.r);
            ctx.fillStyle = p.color;
            ctx.fill();
            if (p.outline) {
                ctx.lineWidth = 1.5;
                ctx.strokeStyle = INK;
                ctx.stroke();
            }
        }
    }
    ctx.globalAlpha = 1;
}

/** A comic burst behind a word ("OUCH!", "SPLAT"). */
export function drawBurst(ctx, x, y, r, fill, spikes = 12, seed = 1) {
    ctx.beginPath();
    for (let i = 0; i <= spikes * 2; i++) {
        const a = (i / (spikes * 2)) * Math.PI * 2 + seed;
        const rr = i % 2 ? r * (0.62 + Math.sin(i * 7.3 + seed) * 0.06) : r;
        ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr * 0.8);
    }
    ctx.closePath();
    inked(ctx, fill, 3);
}

/** Text with an ink outline, for words drawn in the scene. */
export function inkedText(ctx, text, x, y, fill, size, weight = 800, outline = 5) {
    ctx.font = `${weight} ${size}px "Bricolage Grotesque", system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.lineWidth = outline;
    ctx.strokeStyle = INK;
    ctx.strokeText(text, x, y);
    ctx.fillStyle = fill;
    ctx.fillText(text, x, y);
}
