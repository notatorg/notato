// Inbox Zero: your agent resolved the notes, you get to bin them. Each note arrives as a card on your desk,
// crumples into a ball, and you flick it at the bin across the office. A desk fan blows it sideways.
//
// The office is drawn in perspective: x across, y up from the floor, z away from you. Every throw has the same
// arc for the bin's distance, so only the direction you swipe matters, and the skill is aiming into the wind.

import {
    announcer,
    approach,
    bestScore,
    buzz,
    circle,
    clamp,
    confetti,
    drawParticles,
    easeBack,
    easeOut,
    INK,
    inked,
    inkedLine,
    inkedText,
    lerp,
    loop,
    makeCanvas,
    makeSound,
    mix,
    pick,
    rand,
    reduceMotion,
    roundRect,
    seeded,
    showCard,
    stepParticles,
} from "./kit.js";

const stage = document.querySelector('[data-game="toss"]');
const { canvas, ctx, size, begin, local, onResize } = makeCanvas(stage);
const sound = makeSound(stage.querySelector(".mute"));
const say = announcer(stage.querySelector("[data-say]"));
const best = bestScore("inbox-zero");
const hud = Object.fromEntries(
    [...stage.querySelectorAll("[data-hud]")].map((node) => [node.dataset.hud, node])
);

// ------------------------------------------------------------ the office

const GRAVITY = 980;
const CAM_H = 210;
const WALL_Z = 1250;
const ROOM_X = 470;
const ROOM_H = 330;
const BALL_R = 11;
const BIN_R = 50;
const BIN_R_FOOT = 41;
const BIN_H = 82;
const START = { x: 0, y: 92, z: 150 };
const WIND_ACCEL = 62;

const horizon = () => size.h * 0.3;
const focal = () => size.w * 1.05;
/** A point in the office, on the screen: `k` is how many pixels one unit is at that depth. */
function P(x, y, z) {
    const k = focal() / z;
    return { x: size.w / 2 + x * k, y: horizon() + (CAM_H - y) * k, k };
}

const NOTES = [
    "Make it green and say “Place order”",
    "Price wraps on the iPhone SE",
    "Spinner never stops on slow 3G",
    "Typo: “Recieve your order”",
    "Logo is blurry on retina screens",
    "Toast covers the Pay button",
    "Dark mode: card text vanishes",
    "Round these corners a bit more?",
    "Back button empties my basket",
    "Search ignores capital letters",
    "Empty basket needs a kinder message",
    "Double tap orders twice!",
    "Dates show in the wrong format",
    "No focus ring on the links",
    "Footer overlaps in landscape",
    "Checkout button jumps on load",
];
const PEOPLE = [
    ["Alex", "#1f8a78"],
    ["Sam", "#3b82f6"],
    ["Priya", "#8b5cf6"],
    ["Jo", "#ec4899"],
    ["Kai", "#f97316"],
    ["Mo", "#2e9a5b"],
];
const PAPERS = ["#fff1a8", "#d9f3e4", "#ffdbe3", "#dbe8ff", "#fbf5e6"];
/**
 * Notes come in Notato's severities, and each crumples differently: a nit is a scrap the fan carries off, a
 * blocker a fat wad that barely drifts but is hard to drop in cleanly. `drift` scales the wind on it.
 */
const SEVERITY = {
    nit: { chip: "#64748b", size: 0.8, drift: 1.6, points: 3, hint: "light: drifts more" },
    minor: { chip: "#3b82f6", size: 1, drift: 1, points: 1, hint: "" },
    major: { chip: "#f97316", size: 1.15, drift: 0.75, points: 1, hint: "" },
    blocker: { chip: "#e5484d", size: 1.35, drift: 0.35, points: 2, hint: "heavy: barely drifts" },
};

// ------------------------------------------------------------------ state

const game = {
    state: "title", // title | card | crumple | ready | flight | scored | missed
    timer: 0,
    time: 0,
    slow: 1,
    streak: 0,
    binned: 0,
    score: 0,
    wind: 0,
    banner: null,
    bannerTime: 0,
    pin: 0,
    strikes: 0,
    longest: 0,
    dusk: 0,
};
const STRIKES = 3;
/** The streak at which a throw is "on fire". */
const HOT = 5;
/** Notes binned for each step towards night: day, sunset, then night. */
const NOTES_PER_HOUR = 10;
/** The bin; from 20 binned it slides from side to side, `sway` either way of `base`. */
const bin = { x: 0, base: 0, sway: 0, phase: 0, z: 620, wobble: 0, wobbleV: 0, pile: [] };
/** Notes binned before the bin starts to slide. */
const SLIDES = 20;
const fan = { angle: 0 };
/** A swipe runs from `start`, where the pointer went down, to `last`, wherever it is now, however long it takes. */
const aim = { dragging: false, start: null, last: null, keyAngle: 0, keyUsed: false, queued: null };
let note = null; // the card on the desk: { text, who, colour, paper, seed, pin, sev }
let ball = null;
let crumpleT = 0;
const floor = [];
let particles = [];
let gusts = [];
let floaters = [];
let lastNote = -1;

// --------------------------------------------------------------- levels

function distanceFor(streak) {
    if (streak >= 12) return 1050;
    if (streak >= 8) return 890;
    if (streak >= 4) return 730;
    return 580;
}

/** Minors and majors at first, nits from 3 binned, the odd blocker from 6. */
function severityFor(binned) {
    const r = Math.random();
    if (binned >= 6 && r < 0.12) return "blocker";
    if (binned >= 3 && r < 0.4) return "nit";
    return Math.random() < 0.6 ? "minor" : "major";
}

const noteR = () => BALL_R * SEVERITY[note.sev].size;

function newWind() {
    const max = Math.min(0.8 + game.binned * 0.36, 6.5);
    const strength = Math.random() < 0.15 && game.binned < 6 ? 0 : rand(max * 0.3, max);
    game.wind = (Math.round(strength * 10) / 10) * (Math.random() < 0.5 ? -1 : 1);
}

function setHud(node, text) {
    if (node.textContent === text) return;
    node.textContent = text;
    node.classList.remove("bump");
    void node.offsetWidth;
    node.classList.add("bump");
}

function updateHud() {
    setHud(hud.streak, String(game.streak));
    setHud(hud.score, String(game.score));
    setHud(hud.best, String(Math.max(best.value, game.score)));
    hud.streak.parentElement.classList.toggle("hot", game.streak >= HOT);
    const left = STRIKES - game.strikes;
    hud.hearts.innerHTML = `${"♥".repeat(left)}<i>${"♥".repeat(game.strikes)}</i>`;
}

function banner(text, sub) {
    game.banner = { text, sub };
    game.bannerTime = 0.001;
}

// ------------------------------------------------------------------ flow

function nextNote() {
    let index;
    do index = Math.floor(Math.random() * NOTES.length);
    while (index === lastNote);
    lastNote = index;
    const [who, colour] = pick(PEOPLE);
    game.pin += 1;
    note = {
        text: NOTES[index],
        who,
        colour,
        paper: pick(PAPERS),
        seed: rand(0, 1000),
        pin: game.pin,
        sev: severityFor(game.binned),
    };
    const z = distanceFor(game.binned);
    if (z !== bin.z) {
        bin.z = z;
        if (game.binned > 0) banner("The bin moved back", `${Math.round(z / 100)} m away`);
    }
    if (game.binned >= SLIDES) {
        bin.sway = Math.min(70 + (game.binned - SLIDES) * 6, 150);
        bin.base = pick([-1, 0, 1]) * (200 - bin.sway) * 0.6;
        if (game.binned === SLIDES) banner("The bin's on the move", "Throw where it will be");
    } else {
        bin.sway = 0;
        bin.base = game.binned >= 12 ? pick([-150, -70, 0, 70, 150]) : 0;
    }
    bin.phase = rand(0, Math.PI * 2);
    bin.x = bin.base + Math.sin(bin.phase) * bin.sway;
    newWind();
    game.state = "card";
    game.timer = 0;
    crumpleT = 0;
    ball = null;
    updateHud();
    sound.noise(0.12, 2600, 0.08, 0, 5000, "highpass");
    if (note.sev === "blocker")
        for (let i = 0; i < 2; i++) sound.tone(880, 660, 0.18, "square", 0.025, i * 0.22);
    say(
        `New ${note.sev} from ${who}: ${note.text}. Wind ${game.wind ? `${Math.abs(game.wind)} to the ${game.wind > 0 ? "right" : "left"}` : "calm"}.`
    );
}

function crumple() {
    if (game.state !== "card") return;
    game.state = "crumple";
    crumpleT = 0;
    for (let i = 0; i < 5; i++) sound.noise(0.05, 2400, 0.12, i * 0.045, 6000, "highpass");
}

/** Every throw takes this long to reach the bin, further bins a little longer. */
const flightTime = () => 0.72 + (bin.z - START.z) / 2600;

function throwBall(angle) {
    if (game.state !== "ready") return;
    sound.unlock();
    const a = clamp(angle, -0.75, 0.75) * 0.6;
    const T = flightTime();
    const vz = (bin.z - START.z) / T;
    ball = {
        x: START.x,
        y: START.y,
        z: START.z,
        vx: vz * Math.tan(a),
        vy: (BIN_H - START.y + 0.5 * GRAVITY * T * T) / T,
        vz,
        rot: 0,
        spin: rand(5, 9) * (Math.random() < 0.5 ? -1 : 1),
        inside: false,
        rim: false,
        rested: 0,
        paper: note.paper,
        seed: note.seed,
        sev: note.sev,
        r: noteR(),
        drift: SEVERITY[note.sev].drift,
        trail: [],
        hot: game.streak >= HOT,
    };
    game.state = "flight";
    sound.noise(0.32, 500, 0.22, 0, 2600, "bandpass");
}

function scored() {
    game.state = "scored";
    game.timer = 1.25;
    game.streak += 1;
    game.binned += 1;
    const points = SEVERITY[ball.sev].points * (ball.hot ? 2 : 1);
    game.score += points;
    game.longest = Math.max(game.longest, game.streak);
    const fresh = best.offer(game.score);
    buzz(30);
    bin.wobbleV += 9;
    bin.pile.push({
        seed: ball.seed,
        paper: ball.paper,
        r: ball.r,
        dx: rand(-0.5, 0.5),
        dz: rand(-0.4, 0.4),
        rot: rand(0, 6),
    });
    const rim = P(bin.x, BIN_H, bin.z);
    floaters.push({
        kind: "pill",
        text: "✓ Resolved",
        x: rim.x,
        y: rim.y - 50,
        vy: -30,
        life: 1.4,
        max: 1.4,
    });
    floaters.push({
        kind: "word",
        text: `+${points}${ball.hot ? " 🔥" : ""}`,
        x: rim.x + 92,
        y: rim.y - 50,
        vy: -36,
        life: 1.2,
        max: 1.2,
        color: ball.hot ? "#ffb347" : "#f4c56e",
    });
    if (ball.rim)
        floaters.push({
            kind: "word",
            text: "Off the rim!",
            x: rim.x,
            y: rim.y - 96,
            vy: -24,
            life: 1.3,
            max: 1.3,
            color: "#f4c56e",
        });
    particles.push(...confetti(rim.x, rim.y - 10, 30, 0.9).map((p) => ({ ...p, vy: p.vy * 0.8 })));
    sound.noise(0.1, 900, 0.35);
    sound.chime(660 * 2 ** (Math.min(game.streak, 12) / 12), 0.04, 0.09);
    if (game.streak % 5 === 0) {
        const words = { 5: ["On fire!", "Five in a row"], 10: ["Unstoppable!", "Ten in a row"] };
        const [text, sub] = words[game.streak] ?? [
            `${game.streak} in a row!`,
            "Your agent would be proud",
        ];
        banner(text, sub);
        particles.push(...confetti(size.w / 2, size.h * 0.3, 70, 1.6));
        sound.chime(1046, 0.25, 0.08);
    }
    updateHud();
    say(
        `In! ${points} point${points === 1 ? "" : "s"}, ${game.score} in all, streak ${game.streak}.${fresh ? " New best." : ""}`
    );
}

function missed() {
    game.state = "missed";
    game.timer = 1.3;
    const lost = game.streak;
    game.streak = 0;
    game.strikes += 1;
    buzz([50, 40, 50]);
    floor.push({
        x: ball.x,
        z: ball.z,
        r: ball.r,
        rot: ball.rot,
        seed: ball.seed,
        paper: ball.paper,
    });
    if (floor.length > 14) floor.shift();
    const at = P(ball.x, 30, ball.z);
    floaters.push({
        kind: "word",
        text: pick(["Missed!", "So close", "Nope", "Floor note"]),
        x: at.x,
        y: at.y - 30,
        vy: -26,
        life: 1.2,
        max: 1.2,
        color: "#ffffff",
    });
    sound.tone(330, 220, 0.3, "triangle", 0.08);
    sound.tone(247, 165, 0.4, "triangle", 0.07, 0.15);
    updateHud();
    const left = STRIKES - game.strikes;
    say(
        `Missed.${lost ? ` Your streak of ${lost} is over.` : ""} ${left ? `${left} miss${left === 1 ? "" : "es"} left.` : ""}`
    );
}

/** After the third miss: the run's card, then a fresh run. */
async function gameOver() {
    game.state = "over";
    for (const [i, f] of [392, 349, 330].entries())
        sound.tone(f, f * 0.97, 0.3, "triangle", 0.07, i * 0.28);
    const fresh = game.score > 0 && game.score >= best.value;
    const n = game.binned;
    const points = game.score;
    await showCard(stage, {
        kicker: "Game over",
        title: n >= 20 ? "Inbox zero!" : n >= 8 ? "Nearly inbox zero" : "The inbox wins this time",
        big: String(points),
        badge: fresh ? "New best" : undefined,
        text: [
            `point${points === 1 ? "" : "s"}: ${n} note${n === 1 ? "" : "s"} binned, ${game.longest} in a row at best`,
            fresh || !best.value ? "" : `Your best is ${best.value}.`,
        ],
        button: "Play again",
        share: `I scored ${points} point${points === 1 ? "" : "s"} binning ${n} resolved note${n === 1 ? "" : "s"} in Inbox Zero, a game from Notato.`,
    });
    newRun();
}

function newRun() {
    Object.assign(game, { streak: 0, binned: 0, score: 0, strikes: 0, longest: 0 });
    floor.length = 0;
    bin.pile.length = 0;
    bin.z = distanceFor(0);
    banner("Bin it!", "Swipe up to throw");
    nextNote();
    canvas.focus({ preventScroll: true });
}

// ----------------------------------------------------------------- input

canvas.addEventListener("pointerdown", (event) => {
    if (game.state === "card") crumple();
    if (game.state !== "ready" && game.state !== "crumple") return;
    sound.unlock();
    canvas.setPointerCapture(event.pointerId);
    aim.dragging = true;
    aim.keyUsed = false;
    aim.start = local(event);
    aim.last = aim.start;
});
canvas.addEventListener("pointermove", (event) => {
    if (!aim.dragging) return;
    aim.last = local(event);
});
const release = (event) => {
    if (!aim.dragging) return;
    aim.dragging = false;
    if (event.type !== "pointerup") return;
    const swipe = swipeVector();
    if (!swipe) return;
    // Let go while the note is still crumpling, and it goes as soon as it is a ball.
    if (game.state === "ready") throwBall(swipe.angle);
    else if (game.state === "crumple") aim.queued = swipe.angle;
};
canvas.addEventListener("pointerup", release);
canvas.addEventListener("pointercancel", release);

/** The swipe so far: its direction from straight up, and whether it is long enough to be a throw. */
function swipeVector() {
    if (!aim.start || !aim.last) return null;
    const dx = aim.last.x - aim.start.x;
    const dy = aim.last.y - aim.start.y;
    if (dy > -24 || Math.hypot(dx, dy) < 30) return null;
    return { angle: Math.atan2(dx, -dy), length: Math.hypot(dx, dy), dx, dy };
}

document.addEventListener("keydown", (event) => {
    if (event.target.closest?.("button, a, input")) return;
    if (!["card", "ready", "crumple"].includes(game.state)) return;
    const keys = {
        ArrowLeft: () => {
            aim.keyAngle = clamp(aim.keyAngle - 0.03, -0.75, 0.75);
            aim.keyUsed = true;
        },
        ArrowRight: () => {
            aim.keyAngle = clamp(aim.keyAngle + 0.03, -0.75, 0.75);
            aim.keyUsed = true;
        },
        " ": () => {
            if (game.state === "card") crumple();
            else if (game.state === "ready") throwBall(aim.keyAngle);
        },
        Enter: () => keys[" "](),
    };
    const action = keys[event.key];
    if (!action) return;
    event.preventDefault();
    action();
});

// --------------------------------------------------------------- physics

function step(realDt) {
    game.slow = approach(game.slow, game.slowTarget ?? 1, 10, realDt);
    const dt = realDt * (reduceMotion.matches ? 1 : game.slow);
    game.time += dt;
    if (game.bannerTime > 0) game.bannerTime += realDt;
    if (game.bannerTime > 2.4) game.bannerTime = 0;
    fan.angle += dt * (2 + Math.abs(game.wind) * 4.5);
    game.dusk = approach(
        game.dusk,
        Math.min(Math.floor(game.binned / NOTES_PER_HOUR), 2),
        0.6,
        realDt
    );
    // Sparks off a ball that is on fire.
    if (ball && game.state === "flight" && ball.hot && !ball.inside) {
        const at = P(ball.x, ball.y, ball.z);
        for (let i = 0; i < 2; i++)
            particles.push({
                x: at.x + rand(-4, 4),
                y: at.y + rand(-4, 4),
                vx: rand(-40, 40),
                vy: rand(-80, -10),
                r: rand(1.5, 3.5) * Math.min(2, at.k),
                color: pick(["#ffb347", "#ffd84d", "#45bfa8", "#ff7a59"]),
                life: rand(0.25, 0.5),
                max: 0.5,
                gravity: -60,
            });
    }
    if (bin.sway) bin.x = bin.base + Math.sin(game.time * 0.85 + bin.phase) * bin.sway;
    bin.wobbleV += (-bin.wobble * 220 - bin.wobbleV * 10) * dt;
    bin.wobble += bin.wobbleV * dt;

    if (game.state === "card") {
        game.timer += realDt;
        if (game.timer > 0.9) crumple();
    } else if (game.state === "crumple") {
        crumpleT += realDt / 0.38;
        if (crumpleT >= 1) {
            crumpleT = 1;
            game.state = "ready";
            if (aim.queued !== null) {
                throwBall(aim.queued);
                aim.queued = null;
            }
        }
    } else if (game.state === "flight" && ball) {
        const steps = 6;
        for (let i = 0; i < steps && game.state === "flight"; i++) flightStep(dt / steps);
    } else if (game.state === "scored" || game.state === "missed") {
        game.slowTarget = 1;
        if (ball && game.state === "scored") settleInBin(dt);
        game.timer -= realDt;
        if (game.timer <= 0) {
            if (game.strikes >= STRIKES) gameOver();
            else nextNote();
        }
    }

    // Gusts of wind: little lines that blow across the room from the fan.
    const windy = Math.abs(game.wind) / 6.5;
    if (windy && Math.random() < windy * realDt * 26) {
        const dir = Math.sign(game.wind);
        gusts.push({
            x: -dir * rand(300, 520),
            y: rand(40, 230),
            z: rand(350, 1300),
            v: dir * rand(360, 640) * (0.6 + windy),
            len: rand(30, 70),
            life: rand(0.9, 1.5),
            max: 1.5,
        });
    }
    for (const g of gusts) {
        g.x += g.v * realDt;
        g.life -= realDt;
    }
    gusts = gusts.filter((g) => g.life > 0 && Math.abs(g.x) < ROOM_X);
    particles = stepParticles(particles, realDt);
    for (const f of floaters) {
        f.life -= realDt;
        f.y += f.vy * realDt;
    }
    floaters = floaters.filter((f) => f.life > 0);
}

function flightStep(dt) {
    const b = ball;
    const R = b.r;
    const prevY = b.y;
    b.vx += game.wind * b.drift * WIND_ACCEL * dt;
    b.vy -= GRAVITY * dt;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.z += b.vz * dt;
    b.rot += b.spin * dt;
    b.trail.push({ x: b.x, y: b.y, z: b.z });
    if (b.trail.length > 18) b.trail.shift();

    const dx = b.x - bin.x;
    const dz = b.z - bin.z;
    const d = Math.hypot(dx, dz) || 0.001;
    // A moment of slow motion as it comes down by the rim.
    game.slowTarget =
        !b.inside && b.vy < 0 && d < BIN_R + 60 && b.y < BIN_H + 70 && b.y > BIN_H - 20 ? 0.35 : 1;

    if (!b.inside && prevY > BIN_H && b.y <= BIN_H) {
        if (d < BIN_R - R * 0.4) {
            b.inside = true;
        } else if (d < BIN_R + R) {
            // The rim. Near the inside edge it drops in; otherwise it bounces off.
            b.rim = true;
            sound.tone(1750, 1700, 0.3, "triangle", 0.07);
            sound.tone(2620, 2600, 0.22, "sine", 0.04, 0.01);
            bin.wobbleV += 4;
            const nx = dx / d;
            const nz = dz / d;
            if (Math.random() < (d < BIN_R ? 0.7 : 0.2)) {
                b.inside = true;
                b.vx = -nx * 60;
                b.vz = -nz * 60;
                b.vy = 40;
            } else {
                b.y = BIN_H + 1;
                b.vy = Math.abs(b.vy) * 0.38;
                const out = Math.abs(b.vx * nx + b.vz * nz) * 0.45 + 70;
                b.vx = nx * out + b.vx * 0.2;
                b.vz = nz * out + b.vz * 0.2;
            }
        }
    }
    const wallR = lerp(BIN_R_FOOT, BIN_R, clamp(b.y / BIN_H, 0, 1));
    if (b.inside) {
        if (d > wallR - R) {
            b.x = bin.x + (dx / d) * (wallR - R);
            b.z = bin.z + (dz / d) * (wallR - R);
            b.vx *= -0.3;
            b.vz *= -0.3;
        }
        const pile = 8 + Math.min(bin.pile.length, 9) * 7;
        if (b.y <= pile + R) {
            b.y = pile + R;
            scored();
        }
        return;
    }
    if (b.y < BIN_H && d < wallR + R) {
        // Bounces off the side of the bin.
        b.x = bin.x + (dx / d) * (wallR + R);
        b.z = bin.z + (dz / d) * (wallR + R);
        const radial = b.vx * (dx / d) + b.vz * (dz / d);
        if (radial < 0) {
            b.vx -= 1.5 * radial * (dx / d);
            b.vz -= 1.5 * radial * (dz / d);
        }
        sound.tone(420, 380, 0.12, "triangle", 0.06);
        bin.wobbleV += 3;
    }
    if (b.z > WALL_Z - R) {
        b.z = WALL_Z - R;
        b.vz = -Math.abs(b.vz) * 0.3;
    }
    if (Math.abs(b.x) > ROOM_X - R) {
        b.x = Math.sign(b.x) * (ROOM_X - R);
        b.vx = -b.vx * 0.3;
    }
    if (b.y <= R) {
        b.y = R;
        if (Math.abs(b.vy) > 90) {
            b.vy = Math.abs(b.vy) * 0.3;
            b.vx *= 0.55;
            b.vz *= 0.55;
            sound.noise(0.06, 600, 0.18);
        } else {
            b.vy = 0;
            b.vx *= Math.exp(-6 * dt);
            b.vz *= Math.exp(-6 * dt);
            b.rested += dt;
            if (b.rested > 0.25 || Math.hypot(b.vx, b.vz) < 15) missed();
        }
    }
}

function settleInBin(dt) {
    const pile = 8 + Math.min(bin.pile.length - 1, 9) * 7 + ball.r;
    ball.y = approach(ball.y, pile, 8, dt);
    ball.x = approach(ball.x, bin.x, 4, dt);
    ball.z = approach(ball.z, bin.z, 4, dt);
}

// --------------------------------------------------------------- drawing

function draw() {
    begin();
    drawRoom();
    drawBoard();
    drawWindow();
    drawClock();

    // Things on the floor, back to front.
    const things = [
        { z: 900, draw: drawFan },
        ...floor.map((f) => ({ z: f.z, draw: () => drawCrumple(P(f.x, f.r, f.z), f, true) })),
        { z: bin.z, draw: drawBin },
    ];
    if (ball && !ball.inside) things.push({ z: ball.z, draw: drawFlyingBall });
    things.sort((a, b) => b.z - a.z);
    for (const t of things) t.draw();
    drawGusts();

    drawDesk();
    drawEvening();
    if (game.state === "card" || game.state === "crumple") drawCard();
    if (game.state === "crumple" || game.state === "ready") drawHeldBall();
    if (game.state === "ready" || game.state === "card" || game.state === "crumple") drawAim();
    drawWindMeter();
    drawParticles(ctx, particles);
    for (const f of floaters) drawFloater(f);
    if (game.bannerTime > 0 && game.banner) drawBanner();
}

/** As the run goes on the office gets darker, and a warm lamp over the rug comes on. */
function drawEvening() {
    const sunset = clamp(game.dusk, 0, 1);
    const night = clamp(game.dusk - 1, 0, 1);
    if (!sunset) return;
    ctx.fillStyle = `rgba(255, 150, 90, ${0.08 * sunset * (1 - night)})`;
    ctx.fillRect(0, 0, size.w, size.h);
    if (!night) return;
    ctx.fillStyle = `rgba(18, 24, 60, ${0.42 * night})`;
    ctx.fillRect(0, 0, size.w, size.h);
    const lamp = P(0, ROOM_H - 40, 800);
    const glow = ctx.createRadialGradient(lamp.x, lamp.y, 0, lamp.x, lamp.y, size.w * 0.6);
    glow.addColorStop(0, `rgba(255, 214, 140, ${0.38 * night})`);
    glow.addColorStop(1, "rgba(255, 214, 140, 0)");
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, size.w, size.h);
    ctx.restore();
    // The lamp itself, hanging from the ceiling.
    const top = P(0, ROOM_H, 800);
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(top.x, top.y);
    ctx.lineTo(lamp.x, lamp.y - 10 * lamp.k);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(lamp.x - 22 * lamp.k, lamp.y + 4 * lamp.k);
    ctx.lineTo(lamp.x - 8 * lamp.k, lamp.y - 12 * lamp.k);
    ctx.lineTo(lamp.x + 8 * lamp.k, lamp.y - 12 * lamp.k);
    ctx.lineTo(lamp.x + 22 * lamp.k, lamp.y + 4 * lamp.k);
    ctx.closePath();
    inked(ctx, "#1f8a78", Math.max(1.5, 2.5 * lamp.k));
    circle(ctx, lamp.x, lamp.y + 6 * lamp.k, 7 * lamp.k);
    ctx.fillStyle = `rgba(255, 236, 170, ${night})`;
    ctx.fill();
}

function poly(points) {
    ctx.beginPath();
    for (const [i, p] of points.entries()) {
        if (i) ctx.lineTo(p.x, p.y);
        else ctx.moveTo(p.x, p.y);
    }
    ctx.closePath();
}

function drawRoom() {
    const near = 120;
    const back = [
        P(-ROOM_X, 0, WALL_Z),
        P(ROOM_X, 0, WALL_Z),
        P(ROOM_X, ROOM_H, WALL_Z),
        P(-ROOM_X, ROOM_H, WALL_Z),
    ];
    // Ceiling and side walls.
    ctx.fillStyle = "#f6f2ea";
    ctx.fillRect(0, 0, size.w, size.h);
    for (const side of [-1, 1]) {
        poly([
            P(side * ROOM_X, 0, near),
            P(side * ROOM_X, 0, WALL_Z),
            P(side * ROOM_X, ROOM_H, WALL_Z),
            P(side * ROOM_X, ROOM_H, near),
        ]);
        ctx.fillStyle = "#e7dfd0";
        ctx.fill();
        // Skirting board.
        poly([
            P(side * ROOM_X, 0, near),
            P(side * ROOM_X, 0, WALL_Z),
            P(side * ROOM_X, 14, WALL_Z),
            P(side * ROOM_X, 14, near),
        ]);
        ctx.fillStyle = "#d4c8b2";
        ctx.fill();
    }
    // Ceiling.
    poly([
        P(-ROOM_X, ROOM_H, near),
        P(ROOM_X, ROOM_H, near),
        P(ROOM_X, ROOM_H, WALL_Z),
        P(-ROOM_X, ROOM_H, WALL_Z),
    ]);
    const ceiling = ctx.createLinearGradient(0, 0, 0, P(0, ROOM_H, WALL_Z).y);
    ceiling.addColorStop(0, "#e9e3d7");
    ceiling.addColorStop(1, "#f7f3eb");
    ctx.fillStyle = ceiling;
    ctx.fill();
    // Back wall.
    poly(back);
    ctx.fillStyle = "#efe8da";
    ctx.fill();
    poly([
        P(-ROOM_X, 0, WALL_Z),
        P(ROOM_X, 0, WALL_Z),
        P(ROOM_X, 14, WALL_Z),
        P(-ROOM_X, 14, WALL_Z),
    ]);
    ctx.fillStyle = "#d4c8b2";
    ctx.fill();

    // Floor: wooden boards running away from you.
    const floorPoly = [
        P(-ROOM_X, 0, near),
        P(ROOM_X, 0, near),
        P(ROOM_X, 0, WALL_Z),
        P(-ROOM_X, 0, WALL_Z),
    ];
    poly(floorPoly);
    const top = P(0, 0, WALL_Z).y;
    const grad = ctx.createLinearGradient(0, top, 0, size.h);
    grad.addColorStop(0, "#c99a68");
    grad.addColorStop(1, "#dcb282");
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.save();
    poly(floorPoly);
    ctx.clip();
    const board = 62;
    for (let x = -ROOM_X, i = 0; x < ROOM_X; x += board, i++) {
        if (i % 2) continue;
        poly([P(x, 0, near), P(x + board, 0, near), P(x + board, 0, WALL_Z), P(x, 0, WALL_Z)]);
        ctx.fillStyle = "rgba(255, 240, 215, 0.12)";
        ctx.fill();
    }
    ctx.strokeStyle = "rgba(110, 72, 38, 0.3)";
    ctx.lineWidth = 1;
    for (let x = -ROOM_X; x <= ROOM_X; x += board) {
        const a = P(x, 0, near);
        const b = P(x, 0, WALL_Z);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
    }
    for (let z = near, row = 0; z < WALL_Z; z += 160, row++) {
        for (let x = -ROOM_X; x < ROOM_X; x += board) {
            const r = seeded(row * 97 + Math.floor(x / board) + 400);
            const jz = z + r() * 160;
            const a = P(x, 0, jz);
            const b = P(x + board, 0, jz);
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
        }
    }
    // A rug under the bin.
    const rug = [P(-210, 0, 500), P(210, 0, 500), P(210, 0, 1120), P(-210, 0, 1120)];
    poly(rug);
    ctx.fillStyle = "#5fae9c";
    ctx.fill();
    poly([P(-188, 0, 530), P(188, 0, 530), P(188, 0, 1090), P(-188, 0, 1090)]);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.45)";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
    // Corner lines.
    ctx.strokeStyle = "rgba(35, 38, 43, 0.25)";
    ctx.lineWidth = 1.5;
    for (const side of [-1, 1]) {
        const a = P(side * ROOM_X, 0, WALL_Z);
        const b = P(side * ROOM_X, ROOM_H, WALL_Z);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
    }
}

/** A Notato board on the back wall, with a card for each note you have binned. */
function drawBoard() {
    const tl = P(40, 285, WALL_Z - 1);
    const br = P(420, 120, WALL_Z - 1);
    const w = br.x - tl.x;
    const h = br.y - tl.y;
    const k = tl.k;
    roundRect(ctx, tl.x, tl.y, w, h, 10 * k);
    inked(ctx, "#ffffff", Math.max(1.5, 4 * k));
    const columns = [
        ["Open", "#1f8a78", 3],
        ["Acknowledged", "#d99a1e", 2],
        ["Resolved", "#2e9a5b", Math.min(game.binned, 8)],
    ];
    const colW = (w - 16 * k) / 3;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    for (const [i, [name, colour, count]] of columns.entries()) {
        const cx = tl.x + 8 * k + i * colW;
        circle(ctx, cx + 10 * k, tl.y + 20 * k, 5 * k);
        ctx.fillStyle = colour;
        ctx.fill();
        ctx.fillStyle = INK;
        // Shrink a column's name until it fits its column.
        let font = 15 * k;
        ctx.font = `700 ${font}px Figtree, system-ui, sans-serif`;
        const room = colW - 26 * k;
        const width = ctx.measureText(name).width;
        if (width > room) font *= room / width;
        ctx.font = `700 ${Math.max(4, font)}px Figtree, system-ui, sans-serif`;
        ctx.fillText(name, cx + 20 * k, tl.y + 21 * k);
        for (let n = 0; n < count; n++) {
            const col = n % 2;
            const row = Math.floor(n / 2);
            const x = cx + 6 * k + col * (colW / 2 - 2 * k);
            const y = tl.y + 38 * k + row * 34 * k;
            roundRect(ctx, x, y, colW / 2 - 8 * k, 28 * k, 4 * k);
            ctx.fillStyle = i === 2 ? PAPERS[n % PAPERS.length] : "#f2f2ef";
            ctx.fill();
            ctx.lineWidth = Math.max(1, 1.5 * k);
            ctx.strokeStyle = "rgba(35, 38, 43, 0.35)";
            ctx.stroke();
        }
    }
}

function drawWindow() {
    const tl = P(-430, 290, WALL_Z - 1);
    const br = P(-130, 110, WALL_Z - 1);
    const w = br.x - tl.x;
    const h = br.y - tl.y;
    const k = tl.k;
    ctx.save();
    roundRect(ctx, tl.x, tl.y, w, h, 6 * k);
    ctx.clip();
    const sky = ctx.createLinearGradient(0, tl.y, 0, br.y);
    const d = game.dusk;
    const sunset = clamp(d, 0, 1);
    const night = clamp(d - 1, 0, 1);
    sky.addColorStop(0, mix(mix("#8ccbe2", "#6f7fbf", sunset), "#16213f", night));
    sky.addColorStop(1, mix(mix("#d8eef0", "#ffb38a", sunset), "#3a4a78", night));
    ctx.fillStyle = sky;
    ctx.fillRect(tl.x, tl.y, w, h);
    // Clouds going by, and the city.
    ctx.fillStyle = `rgba(255, 255, 255, ${0.9 - night * 0.75})`;
    for (let i = 0; i < 3; i++) {
        const cx = tl.x + ((((game.time * 8 + i * 160) * k) % (w + 80 * k)) - 40 * k);
        const cy = tl.y + (24 + i * 18) * k;
        ctx.beginPath();
        ctx.ellipse(cx, cy, 30 * k, 9 * k, 0, 0, Math.PI * 2);
        ctx.ellipse(cx + 12 * k, cy - 6 * k, 16 * k, 10 * k, 0, 0, Math.PI * 2);
        ctx.fill();
    }
    const r = seeded(42);
    for (let x = tl.x; x < br.x; x += 22 * k) {
        const bh = (40 + r() * 80) * k;
        const light = r() < 0.5;
        ctx.fillStyle = mix(light ? "#9fb9c4" : "#aec6cf", light ? "#24304f" : "#2d3a5c", night);
        ctx.fillRect(x, br.y - bh, 20 * k, bh);
        // More windows light up as the evening comes.
        ctx.fillStyle = `rgba(255, 226, 140, ${0.55 + night * 0.45})`;
        for (let wy = br.y - bh + 6 * k; wy < br.y - 6 * k; wy += 12 * k)
            if (r() < 0.3 + night * 0.35) ctx.fillRect(x + 5 * k, wy, 4 * k, 5 * k);
    }
    ctx.restore();
    roundRect(ctx, tl.x, tl.y, w, h, 6 * k);
    ctx.lineWidth = Math.max(2, 8 * k);
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
    ctx.lineWidth = Math.max(1, 3 * k);
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(tl.x + w / 2, tl.y);
    ctx.lineTo(tl.x + w / 2, br.y);
    ctx.lineWidth = Math.max(2, 6 * k);
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
    // A plant on the sill.
    const pot = P(-170, 110, WALL_Z - 30);
    ctx.fillStyle = "#5fa86b";
    for (const [lx, ly, a] of [
        [-8, -26, -0.5],
        [0, -32, 0],
        [9, -24, 0.6],
        [-14, -16, -0.9],
        [14, -14, 0.9],
    ]) {
        ctx.beginPath();
        ctx.ellipse(
            pot.x + lx * pot.k * 1.6,
            pot.y + ly * pot.k * 1.6,
            5 * pot.k * 1.6,
            13 * pot.k * 1.6,
            a,
            0,
            Math.PI * 2
        );
        inked(ctx, "#6fb87a", Math.max(1, 2 * pot.k));
    }
    roundRect(
        ctx,
        pot.x - 14 * pot.k * 1.6,
        pot.y - 6 * pot.k * 1.6,
        28 * pot.k * 1.6,
        22 * pot.k * 1.6,
        3 * pot.k
    );
    inked(ctx, "#d8953f", Math.max(1, 2.5 * pot.k));
}

function drawClock() {
    const c = P(-45, 262, WALL_Z - 1);
    const r = 26 * c.k * 1.4;
    circle(ctx, c.x, c.y, r);
    inked(ctx, "#ffffff", Math.max(1.5, 3 * c.k));
    const now = new Date();
    const hours = (now.getHours() % 12) + now.getMinutes() / 60;
    const minutes = now.getMinutes() + now.getSeconds() / 60;
    ctx.lineCap = "round";
    ctx.strokeStyle = INK;
    for (const [value, max, length, width] of [
        [hours, 12, 0.5, 3],
        [minutes, 60, 0.75, 2],
    ]) {
        const a = (value / max) * Math.PI * 2 - Math.PI / 2;
        ctx.lineWidth = Math.max(1, width * c.k * 1.4);
        ctx.beginPath();
        ctx.moveTo(c.x, c.y);
        ctx.lineTo(c.x + Math.cos(a) * r * length, c.y + Math.sin(a) * r * length);
        ctx.stroke();
    }
    circle(ctx, c.x, c.y, Math.max(1.5, 2.5 * c.k));
    ctx.fillStyle = "#e5484d";
    ctx.fill();
}

function drawFan() {
    const dir = Math.sign(game.wind) || 1;
    const x = -dir * 330;
    const z = 900;
    const base = P(x, 0, z);
    const head = P(x, 175, z);
    const k = base.k;
    // Stand.
    ctx.fillStyle = "rgba(35, 38, 43, 0.18)";
    ctx.beginPath();
    ctx.ellipse(base.x, base.y, 46 * k, 12 * k, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(base.x, base.y - 3 * k, 36 * k, 10 * k, 0, 0, Math.PI * 2);
    inked(ctx, "#5b6773", Math.max(1.5, 3 * k));
    inkedLine(
        ctx,
        [
            [base.x, base.y - 6 * k],
            [head.x, head.y],
        ],
        "#9aa3ad",
        7 * k,
        Math.max(1, 2.5 * k)
    );
    // The head faces across the room, so it is drawn as an ellipse.
    const R = 76 * k;
    const squash = 0.42;
    ctx.save();
    ctx.translate(head.x + dir * 6 * k, head.y);
    ctx.beginPath();
    ctx.ellipse(-dir * 14 * k, 0, 18 * k, 24 * k, 0, 0, Math.PI * 2);
    inked(ctx, "#5b6773", Math.max(1.5, 3 * k));
    ctx.beginPath();
    ctx.ellipse(0, 0, R * squash, R, 0, 0, Math.PI * 2);
    inked(ctx, "rgba(220, 235, 240, 0.65)", Math.max(1.5, 3 * k));
    ctx.save();
    ctx.scale(squash, 1);
    ctx.globalAlpha = 0.9;
    for (let i = 0; i < 3; i++) {
        ctx.save();
        ctx.rotate(fan.angle + (i * Math.PI * 2) / 3);
        ctx.beginPath();
        ctx.ellipse(0, -R * 0.48, R * 0.2, R * 0.42, 0.3, 0, Math.PI * 2);
        ctx.fillStyle = "#45bfa8";
        ctx.fill();
        ctx.restore();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
    circle(ctx, 0, 0, 7 * k);
    inked(ctx, "#f4c56e", Math.max(1, 2 * k));
    // The cage.
    ctx.strokeStyle = "rgba(35, 38, 43, 0.55)";
    ctx.lineWidth = Math.max(1, 1.5 * k);
    for (let i = 1; i < 4; i++) {
        ctx.beginPath();
        ctx.ellipse(0, 0, R * squash * (i / 4), R * (i / 4), 0, 0, Math.PI * 2);
        ctx.stroke();
    }
    ctx.restore();
}

function drawBin() {
    const wob = bin.wobble * 0.04;
    const top = {
        f: P(bin.x, BIN_H, bin.z - BIN_R),
        b: P(bin.x, BIN_H, bin.z + BIN_R),
        c: P(bin.x, BIN_H, bin.z),
    };
    const foot = {
        f: P(bin.x, 0, bin.z - BIN_R_FOOT),
        b: P(bin.x, 0, bin.z + BIN_R_FOOT),
        c: P(bin.x, 0, bin.z),
    };
    const k = top.c.k;
    const topR = { x: BIN_R * k * (1 + wob), y: (top.f.y - top.b.y) / 2 };
    const topY = (top.f.y + top.b.y) / 2;
    const footR = { x: BIN_R_FOOT * foot.c.k, y: (foot.f.y - foot.b.y) / 2 };
    const footY = (foot.f.y + foot.b.y) / 2;

    // Shadow.
    ctx.fillStyle = "rgba(35, 38, 43, 0.2)";
    ctx.beginPath();
    ctx.ellipse(
        foot.c.x + 6 * k,
        footY + 2 * k,
        footR.x * 1.35,
        footR.y * 1.6 + 2,
        0,
        0,
        Math.PI * 2
    );
    ctx.fill();

    // The inside, and the notes already in it.
    ctx.beginPath();
    ctx.ellipse(top.c.x, topY, topR.x, topR.y, 0, 0, Math.PI * 2);
    ctx.fillStyle = "#145e52";
    ctx.fill();
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(top.c.x, topY, topR.x, topR.y, 0, 0, Math.PI * 2);
    ctx.rect(top.c.x - topR.x * 1.2, topY, topR.x * 2.4, size.h);
    ctx.clip();
    const pile = Math.min(bin.pile.length, 9);
    const shown = bin.pile.slice(-6);
    for (const [i, n] of shown.entries()) {
        const y = 8 + Math.max(0, pile - shown.length + i) * 7 + n.r;
        drawCrumple(P(bin.x + n.dx * BIN_R * 0.8, y, bin.z + n.dz * BIN_R * 0.8), n, false);
    }
    if (ball?.inside) drawCrumple(P(ball.x, ball.y, ball.z), ball, false);
    ctx.restore();

    // The body: a teal bin, a white band and a "done" label.
    ctx.beginPath();
    ctx.moveTo(top.c.x - topR.x, topY);
    ctx.lineTo(foot.c.x - footR.x, footY);
    ctx.ellipse(foot.c.x, footY, footR.x, footR.y, 0, Math.PI, 0, true);
    ctx.lineTo(top.c.x + topR.x, topY);
    ctx.ellipse(top.c.x, topY, topR.x, topR.y, 0, 0, Math.PI, false);
    ctx.closePath();
    inked(ctx, "#1f8a78", Math.max(1.5, 3.5 * k));
    ctx.save();
    ctx.clip();
    ctx.fillStyle = "rgba(255, 255, 255, 0.16)";
    ctx.fillRect(top.c.x - topR.x * 0.7, topY, topR.x * 0.3, footY - topY + footR.y);
    ctx.fillStyle = "rgba(0, 0, 0, 0.12)";
    ctx.fillRect(top.c.x + topR.x * 0.55, topY, topR.x * 0.5, footY - topY + footR.y);
    ctx.restore();
    // Label.
    const ly = lerp(topY, footY, 0.5);
    const lw = topR.x * 1.25;
    const lh = (footY - topY) * 0.34;
    roundRect(ctx, top.c.x - lw / 2, ly - lh / 2, lw, lh, 4 * k);
    inked(ctx, "#ffffff", Math.max(1, 2 * k));
    ctx.fillStyle = "#2e9a5b";
    ctx.font = `800 ${Math.max(6, lh * 0.6)}px "Bricolage Grotesque", system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("✓ DONE", top.c.x, ly + 1);
    // The rim, in front.
    ctx.beginPath();
    ctx.ellipse(top.c.x, topY, topR.x, topR.y, 0, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(2, 7 * k);
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.lineWidth = Math.max(1, 3.5 * k);
    ctx.strokeStyle = "#45bfa8";
    ctx.stroke();
}

/** A crumpled note at a projected point; `paper` and `seed` make each one its own. */
function drawCrumple(at, n, shadow, scale = 1) {
    const r = (n.r ?? BALL_R) * at.k * scale;
    if (shadow) {
        ctx.fillStyle = "rgba(35, 38, 43, 0.18)";
        ctx.beginPath();
        ctx.ellipse(at.x + r * 0.2, at.y + r * 0.85, r * 1.1, r * 0.35, 0, 0, Math.PI * 2);
        ctx.fill();
    }
    crumpleShape(at.x, at.y, r, n.rot ?? 0, n.seed, n.paper);
}

function crumpleShape(x, y, r, rot, seed, paper, flat = 0) {
    const rng = seeded(Math.floor(seed * 1000) + 7);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.beginPath();
    const points = 11;
    for (let i = 0; i < points; i++) {
        const a = (i / points) * Math.PI * 2;
        const rr = r * (0.82 + rng() * 0.3);
        ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr * (1 - flat * 0.3));
    }
    ctx.closePath();
    inked(ctx, paper, Math.max(1.2, r * 0.16));
    ctx.save();
    ctx.clip();
    ctx.fillStyle = "rgba(0, 0, 0, 0.08)";
    ctx.beginPath();
    ctx.ellipse(r * 0.3, r * 0.35, r * 0.9, r * 0.6, 0.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = "rgba(35, 38, 43, 0.4)";
    ctx.lineWidth = Math.max(0.8, r * 0.08);
    for (let i = 0; i < 4; i++) {
        const a = rng() * Math.PI * 2;
        const l = r * (0.4 + rng() * 0.4);
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * r * 0.1, Math.sin(a) * r * 0.1);
        ctx.lineTo(Math.cos(a) * l, Math.sin(a) * l);
        ctx.lineTo(Math.cos(a + 0.5) * l * 1.1, Math.sin(a + 0.5) * l * 1.1);
        ctx.stroke();
    }
    ctx.restore();
}

function drawFlyingBall() {
    const at = P(ball.x, ball.y, ball.z);
    const ground = P(ball.x, 0, ball.z);
    const height = clamp(ball.y / 300, 0, 1);
    ctx.fillStyle = `rgba(35, 38, 43, ${0.22 * (1 - height * 0.7)})`;
    ctx.beginPath();
    ctx.ellipse(
        ground.x,
        ground.y,
        ball.r * ground.k * (1.2 + height),
        ball.r * ground.k * 0.4,
        0,
        0,
        Math.PI * 2
    );
    ctx.fill();
    // A fading streak behind it.
    ctx.lineCap = "round";
    for (let i = 1; i < ball.trail.length; i++) {
        const a = P(ball.trail[i - 1].x, ball.trail[i - 1].y, ball.trail[i - 1].z);
        const b = P(ball.trail[i].x, ball.trail[i].y, ball.trail[i].z);
        const fade = (i / ball.trail.length) * 0.5;
        ctx.strokeStyle = ball.hot
            ? `rgba(255, 170, 70, ${fade * 1.4})`
            : `rgba(255, 255, 255, ${fade})`;
        ctx.lineWidth = ball.r * b.k * (i / ball.trail.length) * 1.2;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
    }
    crumpleShape(at.x, at.y, ball.r * at.k, ball.rot, ball.seed, ball.paper);
}

function drawGusts() {
    ctx.lineCap = "round";
    for (const g of gusts) {
        const a = P(g.x, g.y, g.z);
        const b = P(g.x - Math.sign(g.v) * g.len, g.y, g.z);
        const alpha = clamp(g.life / g.max, 0, 1) * 0.6;
        ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`;
        ctx.lineWidth = Math.max(1, 3 * a.k);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.quadraticCurveTo((a.x + b.x) / 2, a.y - 4 * a.k * Math.sin(g.x * 0.02), b.x, b.y);
        ctx.stroke();
    }
}

function deskTop() {
    return size.h * 0.86;
}

function drawDesk() {
    const top = deskTop();
    ctx.beginPath();
    ctx.moveTo(-10, top);
    ctx.lineTo(size.w + 10, top);
    ctx.lineTo(size.w + 10, size.h + 10);
    ctx.lineTo(-10, size.h + 10);
    ctx.closePath();
    inked(ctx, "#c48a52", 3);
    ctx.fillStyle = "#d39a5f";
    ctx.fillRect(0, top + 1.5, size.w, 7);
    ctx.strokeStyle = "rgba(110, 72, 38, 0.25)";
    ctx.lineWidth = 1.5;
    for (let i = 1; i < 4; i++) {
        ctx.beginPath();
        ctx.moveTo(0, top + 14 + i * 14);
        ctx.bezierCurveTo(
            size.w * 0.3,
            top + 10 + i * 14,
            size.w * 0.6,
            top + 20 + i * 14,
            size.w,
            top + 12 + i * 14
        );
        ctx.stroke();
    }
    // A mug of coffee, steaming.
    const s = clamp(size.w / 640, 0.6, 1.1);
    const mx = size.w * 0.12;
    const my = top + 8 * s;
    ctx.save();
    ctx.translate(mx, my);
    ctx.scale(s, s);
    ctx.beginPath();
    ctx.ellipse(28, -26, 13, 15, 0, 0, Math.PI * 2);
    ctx.lineWidth = 9;
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.lineWidth = 4;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
    roundRect(ctx, -26, -60, 52, 62, [6, 6, 14, 14]);
    inked(ctx, "#ffffff", 3);
    ctx.beginPath();
    ctx.ellipse(0, -60, 26, 7, 0, 0, Math.PI * 2);
    inked(ctx, "#6b4a2f", 3);
    ctx.fillStyle = "#1f8a78";
    roundRect(ctx, -12, -42, 24, 18, 4);
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.7)";
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    for (let i = 0; i < 3; i++) {
        const t = (game.time * 0.6 + i / 3) % 1;
        ctx.globalAlpha = Math.sin(t * Math.PI) * 0.8;
        ctx.beginPath();
        ctx.moveTo(-8 + i * 8, -70 - t * 30);
        ctx.quadraticCurveTo(-14 + i * 8, -80 - t * 30, -8 + i * 8, -92 - t * 30);
        ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
    // The rest of the pile, still to go, with a pencil.
    ctx.save();
    ctx.translate(size.w * 0.87, top + 10 * s);
    ctx.scale(s, s);
    ctx.rotate(-0.05);
    const pad = 4;
    for (let i = 0; i < pad; i++) {
        roundRect(ctx, -40 + (i % 2) * 3, -12 - i * 7, 80, 12, 3);
        inked(ctx, i % 2 ? "#f4c56e" : "#f7d488", 2.5);
    }
    // The top note, seen from above the desk.
    const y = -12 - pad * 7;
    ctx.beginPath();
    ctx.moveTo(-36, y + 7);
    ctx.lineTo(-28, y - 14);
    ctx.lineTo(44, y - 14);
    ctx.lineTo(40, y + 7);
    ctx.closePath();
    inked(ctx, "#fde29a", 2.5);
    ctx.strokeStyle = "rgba(35, 38, 43, 0.35)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-20, y - 7);
    ctx.lineTo(24, y - 7);
    ctx.moveTo(-23, y);
    ctx.lineTo(10, y);
    ctx.stroke();
    ctx.restore();
    // A pencil in front of the pile.
    ctx.save();
    ctx.translate(size.w * 0.84, top + 22 * s);
    ctx.scale(s, s);
    ctx.rotate(0.12);
    ctx.beginPath();
    ctx.moveTo(-34, -4);
    ctx.lineTo(26, -4);
    ctx.lineTo(38, 0);
    ctx.lineTo(26, 4);
    ctx.lineTo(-34, 4);
    ctx.closePath();
    inked(ctx, "#f4c56e", 2.5);
    ctx.beginPath();
    ctx.moveTo(26, -4);
    ctx.lineTo(38, 0);
    ctx.lineTo(26, 4);
    ctx.closePath();
    inked(ctx, "#f2dcb8", 2);
    roundRect(ctx, -40, -4, 7, 8, 2);
    inked(ctx, "#ec4899", 2);
    ctx.restore();
}

/**
 * A severity chip, as Notato draws one: a dot and the name, with the points and a hint after it. `x`, `y` is
 * its left middle, and `hot` doubles the points. Returns its width.
 */
function drawSeverityChip(sev, x, y, withHint, hot = false) {
    const s = SEVERITY[sev];
    const points = `+${s.points * (hot ? 2 : 1)}${hot ? " 🔥" : ""}`;
    const hint = withHint && s.hint ? ` · ${s.hint}` : "";
    ctx.font = "700 12px 'JetBrains Mono', monospace";
    const label = sev + hint;
    const lw = ctx.measureText(label).width;
    const pw = ctx.measureText(points).width;
    const w = lw + pw + 40;
    roundRect(ctx, x, y - 11, w, 22, 11);
    inked(ctx, "#ffffff", 2);
    circle(ctx, x + 11, y, 4);
    ctx.fillStyle = s.chip;
    ctx.fill();
    ctx.fillStyle = INK;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(label, x + 19, y + 1);
    ctx.fillStyle = "#1f8a78";
    ctx.fillText(points, x + 27 + lw, y + 1);
    return w;
}

/** The note on the desk, as a card in Notato's style, crumpling into a ball. */
function drawCard() {
    const t = game.state === "crumple" ? easeOut(crumpleT) : 0;
    const enter = easeBack(clamp(game.timer / 0.35, 0, 1));
    const w = clamp(size.w * 0.5, 210, 290);
    const h = w * 0.62;
    const held = heldPosition();
    const cx = lerp(size.w / 2, held.x, t);
    const cy = lerp(deskTop() - h * 0.42, held.y, t) + (1 - enter) * 60;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(lerp(-0.035, 0.6, t) + Math.sin(note.seed) * 0.02);
    const sc = lerp(1, 0.12, t);
    ctx.scale(sc * (1 + Math.sin(t * 20) * 0.08 * t), sc);
    ctx.globalAlpha = 1 - clamp((t - 0.7) / 0.3, 0, 1);
    ctx.fillStyle = "rgba(35, 38, 43, 0.2)";
    roundRect(ctx, -w / 2 + 5, -h / 2 + 8, w, h, 10);
    ctx.fill();
    roundRect(ctx, -w / 2, -h / 2, w, h, 10);
    inked(ctx, note.paper, 3);
    // Pin, author and status, as the toolbar's cards show them.
    circle(ctx, -w / 2 + 6, -h / 2 + 6, 14);
    inked(ctx, "#1f8a78", 2.5);
    ctx.fillStyle = "#ffffff";
    ctx.font = "800 14px Figtree, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(note.pin), -w / 2 + 6, -h / 2 + 7);
    const pad = 18;
    circle(ctx, -w / 2 + pad + 11, -h / 2 + pad + 12, 11);
    inked(ctx, note.colour, 2);
    ctx.fillStyle = "#ffffff";
    ctx.font = "800 12px Figtree, system-ui, sans-serif";
    ctx.fillText(note.who[0], -w / 2 + pad + 11, -h / 2 + pad + 13);
    ctx.textAlign = "left";
    ctx.fillStyle = INK;
    ctx.font = "700 14px Figtree, system-ui, sans-serif";
    ctx.fillText(note.who, -w / 2 + pad + 28, -h / 2 + pad + 13);
    ctx.font = "600 12px Figtree, system-ui, sans-serif";
    const chip = "✓ Resolved";
    const cw = ctx.measureText(chip).width + 16;
    roundRect(ctx, w / 2 - pad - cw, -h / 2 + pad + 2, cw, 21, 10.5);
    ctx.fillStyle = "#2e9a5b";
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.fillText(chip, w / 2 - pad - cw + 8, -h / 2 + pad + 13);
    ctx.fillStyle = "#3a3226";
    ctx.font = `600 ${Math.round(w * 0.066)}px Figtree, system-ui, sans-serif`;
    wrap(note.text, -w / 2 + pad, -h / 2 + pad + 48, w - pad * 2, w * 0.085);
    drawSeverityChip(note.sev, -w / 2 + pad - 4, h / 2 - pad - 4, true, game.streak >= HOT);
    ctx.globalAlpha = 1;
    ctx.restore();
}

function wrap(text, x, y, width, lineHeight) {
    const words = text.split(" ");
    let line = "";
    let row = 0;
    for (const word of words) {
        const test = line ? `${line} ${word}` : word;
        if (ctx.measureText(test).width > width && line) {
            ctx.fillText(line, x, y + row * lineHeight);
            line = word;
            row++;
        } else line = test;
    }
    ctx.fillText(line, x, y + row * lineHeight);
}

function heldPosition() {
    const at = P(START.x, START.y, START.z);
    let x = at.x;
    let y = Math.min(at.y, deskTop() - noteR() * at.k * 0.6);
    // The ball follows a drag a little.
    if (aim.dragging && aim.start) {
        x += clamp(aim.last.x - aim.start.x, -40, 40) * 0.4;
        y += clamp(aim.last.y - aim.start.y, -50, 20) * 0.3;
    }
    return { x, y, k: at.k };
}

function drawHeldBall() {
    const held = heldPosition();
    const grow = game.state === "crumple" ? easeBack(clamp((crumpleT - 0.45) / 0.55, 0, 1)) : 1;
    if (grow <= 0) return;
    const bob = game.state === "ready" ? Math.sin(game.time * 3) * 2 : 0;
    ctx.fillStyle = "rgba(35, 38, 43, 0.2)";
    ctx.beginPath();
    ctx.ellipse(
        held.x + 4,
        deskTop() + 10,
        noteR() * held.k * 1.1 * grow,
        7 * grow,
        0,
        0,
        Math.PI * 2
    );
    ctx.fill();
    crumpleShape(
        held.x,
        held.y + bob,
        noteR() * held.k * grow,
        game.time * 0.3,
        note.seed,
        note.paper
    );
    if (game.state === "ready" && !aim.dragging)
        drawSeverityChip(
            note.sev,
            held.x + noteR() * held.k + 14,
            held.y + bob - noteR() * held.k * 0.6,
            false,
            game.streak >= HOT
        );
}

function drawAim() {
    let angle;
    let strength;
    if (aim.dragging) {
        const swipe = swipeVector();
        if (!swipe) return;
        angle = swipe.angle;
        strength = clamp(swipe.length / 160, 0.4, 1);
    } else if (aim.keyUsed) {
        angle = aim.keyAngle;
        strength = 0.8;
    } else return;
    const held = heldPosition();
    const a = clamp(angle, -0.75, 0.75);
    const len = 70 + strength * 60;
    const sx = held.x;
    const sy = held.y - noteR() * held.k - 10;
    const ex = sx + Math.sin(a) * len;
    const ey = sy - Math.cos(a) * len;
    inkedLine(
        ctx,
        [
            [sx, sy],
            [ex, ey],
        ],
        "#45bfa8",
        6,
        2.5
    );
    ctx.save();
    ctx.translate(ex, ey);
    ctx.rotate(a);
    ctx.beginPath();
    ctx.moveTo(0, -12);
    ctx.lineTo(-10, 4);
    ctx.lineTo(10, 4);
    ctx.closePath();
    inked(ctx, "#45bfa8", 2.5);
    ctx.restore();
}

/** The wind, as a sign hanging at the top of the room: the number, and an arrow as long as the wind is strong. */
function drawWindMeter() {
    const w = 150;
    const x = size.w / 2;
    const y = Math.max(72, size.h * 0.11);
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(x + side * 40, 0);
        ctx.lineTo(x + side * 40, y - 22);
        ctx.stroke();
    }
    roundRect(ctx, x - w / 2, y - 24, w, 48, 14);
    inked(ctx, "#17181b", 3);
    const strength = Math.abs(game.wind) / 6.5;
    const dir = Math.sign(game.wind);
    ctx.textBaseline = "middle";
    if (!dir) {
        ctx.fillStyle = "#eceded";
        ctx.font = "700 16px 'JetBrains Mono', monospace";
        ctx.textAlign = "center";
        ctx.fillText("no wind", x, y + 1);
        return;
    }
    ctx.fillStyle = "#eceded";
    ctx.font = "800 22px 'Bricolage Grotesque', system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(Math.abs(game.wind).toFixed(1), x - dir * 36, y + 1);
    const len = 22 + strength * 44;
    const ax = x + dir * 8;
    const flutter = Math.sin(game.time * 14) * 1.5;
    ctx.strokeStyle = "#45bfa8";
    ctx.lineWidth = 5;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(ax, y + flutter * 0.3);
    ctx.lineTo(ax + dir * len, y + flutter * 0.3);
    ctx.stroke();
    ctx.fillStyle = "#45bfa8";
    ctx.beginPath();
    ctx.moveTo(ax + dir * (len + 10), y);
    ctx.lineTo(ax + dir * (len - 2), y - 9);
    ctx.lineTo(ax + dir * (len - 2), y + 9);
    ctx.closePath();
    ctx.fill();
}

function drawFloater(f) {
    const age = f.max - f.life;
    const pop = easeBack(clamp(age / 0.35, 0, 1));
    ctx.save();
    ctx.globalAlpha = clamp(f.life / 0.35, 0, 1);
    ctx.translate(f.x, f.y);
    ctx.scale(pop, pop);
    if (f.kind === "pill") {
        ctx.font = "700 17px Figtree, system-ui, sans-serif";
        const w = ctx.measureText(f.text).width + 28;
        roundRect(ctx, -w / 2, -16, w, 32, 16);
        inked(ctx, "#2e9a5b", 3);
        ctx.fillStyle = "#ffffff";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(f.text, 0, 1);
    } else inkedText(ctx, f.text, 0, 0, f.color ?? "#ffffff", 22, 800, 5);
    ctx.restore();
}

function drawBanner() {
    const t = game.bannerTime;
    const enter = easeBack(clamp(t / 0.45, 0, 1));
    const leave = clamp((t - 1.9) / 0.4, 0, 1);
    ctx.save();
    ctx.globalAlpha = Math.min(1, t * 4) * (1 - leave);
    ctx.translate(size.w / 2, size.h * 0.4 - (1 - enter) * 40 - leave * 30);
    ctx.rotate(-0.04);
    ctx.scale(lerp(0.6, 1, enter), lerp(0.6, 1, enter));
    const big = clamp(size.w * 0.09, 30, 54);
    inkedText(ctx, game.banner.text, 0, 0, "#f4c56e", big, 800, Math.max(5, big * 0.15));
    if (game.banner.sub) {
        ctx.font = "700 14px Figtree, system-ui, sans-serif";
        const w = ctx.measureText(game.banner.sub).width + 26;
        roundRect(ctx, -w / 2, big * 0.6, w, 28, 14);
        inked(ctx, "#17181b", 2.5);
        ctx.fillStyle = "#eceded";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(game.banner.sub, 0, big * 0.6 + 15);
    }
    ctx.restore();
}

// -------------------------------------------------------------------- go

let started = false;
const debug = { paused: false };
note = { text: NOTES[0], who: "Alex", colour: "#1f8a78", paper: PAPERS[0], seed: 1, pin: 1 };
newWind();
updateHud();
loop((dt) => {
    if (debug.paused) return;
    if (!started) {
        game.time += dt;
        fan.angle += dt * 4;
    } else step(dt);
    draw();
});
// A resize clears the canvas, so draw again at once rather than at the next frame.
onResize(() => draw());

if (new URLSearchParams(location.search).has("debug"))
    window.inboxZero = {
        game,
        bin,
        aim,
        debug,
        get ball() {
            return ball;
        },
        get note() {
            return note;
        },
        throwBall,
        crumple,
        tick(seconds) {
            for (let t = 0; t < seconds; t += 1 / 60) step(1 / 60);
            draw();
        },
    };

showCard(stage, {
    kicker: "A Notato game",
    title: "Inbox Zero",
    image: "../notato.png",
    text: "Your agent fixed them. You get to bin them. Swipe up to throw, and aim into the wind.",
    button: "Start binning",
}).then(() => {
    started = true;
    newRun();
});
