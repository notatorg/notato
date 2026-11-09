// Spud Cannon: knock the bug off the top of a stack of potatoes with a potato, and don't hit the stack. Drag back to
// aim like a slingshot, let go to fire. Each bug sends the stack further away; wind, the web's annoyances and a
// fidgety stack join in as it goes.
//
// The scene is in world units: the cannon's wheel at x 0, the ground at y 0, up is negative. A camera frames the
// shot, follows the potato, and closes in on whatever it hits.

import {
    announcer,
    approach,
    bestScore,
    buzz,
    circle,
    clamp,
    confetti,
    drawBurst,
    drawParticles,
    drawPotato,
    easeBack,
    easeInOut,
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

const stage = document.querySelector('[data-game="cannon"]');
const { canvas, ctx, size, begin, local, onResize } = makeCanvas(stage);
const sound = makeSound(stage.querySelector(".mute"));
const say = announcer(stage.querySelector("[data-say]"));
const best = bestScore("spud-cannon");
const hud = Object.fromEntries(
    [...stage.querySelectorAll("[data-hud]")].map((node) => [node.dataset.hud, node])
);

// ---------------------------------------------------------------- sizes

const GRAVITY = 900;
const MIN_SPEED = 220;
const MAX_SPEED = 1180;
const POTATO_R = 12;
const PIVOT = { x: 0, y: -46 };
const BARREL = 98;
const MIN_ANGLE = (4 * Math.PI) / 180;
const MAX_ANGLE = (84 * Math.PI) / 180;
const HEAD_R = 26;
/** The middle of the top potato of a stack, where the bug lives. */
const HEAD_Y = -132;
const BUG_R = 14;

/**
 * Bugs come in Notato's severities. A nit is small and hard to hit; a blocker is big, scurries about and has a
 * siren. Points are what a hit is worth (one more for doing it with the first potato).
 */
const SEVERITY = {
    nit: { r: 9, body: "#7cc36a", chip: "#64748b", points: 2, pace: 1.3 },
    minor: { r: 14, body: "#e5484d", chip: "#3b82f6", points: 1, pace: 1 },
    major: { r: 16, body: "#f59e0b", chip: "#f97316", points: 2, pace: 1 },
    blocker: { r: 17, body: "#8b5cf6", chip: "#e5484d", points: 3, pace: 2.4 },
};
const bugSize = () => SEVERITY[bug.sev].r;

/**
 * The time of day, which moves on every few bugs: day, golden hour, sunset, then night. `haze` tints the far
 * hills and `shade` the scene itself, as [r, g, b, alpha].
 */
const SKIES = [
    {
        top: "#7fc2dc",
        mid: "#cfe9e6",
        low: "#eef5e4",
        sun: "#fff1b8",
        sunY: 0.2,
        cloud: "#ffffff",
        haze: [255, 255, 255, 0],
        shade: [0, 0, 0, 0],
    },
    {
        top: "#86b4d6",
        mid: "#f1dcb6",
        low: "#fbe8c4",
        sun: "#ffd77e",
        sunY: 0.34,
        cloud: "#fff3e0",
        haze: [255, 190, 110, 0.12],
        shade: [255, 170, 80, 0.07],
    },
    {
        top: "#5a6aa6",
        mid: "#ee9f7d",
        low: "#f8c48f",
        sun: "#ff9d5c",
        sunY: 0.52,
        cloud: "#ffd6c2",
        haze: [240, 120, 90, 0.2],
        shade: [190, 80, 90, 0.14],
    },
    {
        top: "#141d38",
        mid: "#2b3964",
        low: "#59608c",
        sun: "#f4f1de",
        sunY: 0.18,
        cloud: "#6f7aa3",
        haze: [16, 24, 64, 0.5],
        shade: [16, 24, 70, 0.34],
    },
];
const BUGS_PER_HOUR = 4;

/** The sky now: between two of SKIES, as far as `game.dusk` has got. */
function skyNow() {
    const at = clamp(game.dusk, 0, SKIES.length - 1);
    const a = SKIES[Math.floor(at)];
    const b = SKIES[Math.min(Math.ceil(at), SKIES.length - 1)];
    const t = at - Math.floor(at);
    const rgba = (x, y) => {
        const v = x.map((n, i) => lerp(n, y[i], t));
        return `rgba(${Math.round(v[0])}, ${Math.round(v[1])}, ${Math.round(v[2])}, ${v[3].toFixed(3)})`;
    };
    return {
        top: mix(a.top, b.top, t),
        mid: mix(a.mid, b.mid, t),
        low: mix(a.low, b.low, t),
        sun: mix(a.sun, b.sun, t),
        cloud: mix(a.cloud, b.cloud, t),
        sunY: lerp(a.sunY, b.sunY, t),
        haze: rgba(a.haze, b.haze),
        shade: rgba(a.shade, b.shade),
        night: clamp(at - 2, 0, 1),
    };
}
const stars = Array.from({ length: 60 }, () => ({
    x: Math.random(),
    y: Math.random() * 0.55,
    r: rand(0.6, 1.8),
    p: rand(0, 6),
}));

function severityFor(level) {
    if (level <= 2) return "minor";
    const roll = Math.random();
    if (level >= 4 && roll < 0.14) return "blocker";
    if (roll < 0.36) return "major";
    if (roll < 0.56) return "nit";
    return "minor";
}
const METRE = 35;

const distanceFor = (level) => Math.min(450 + (level - 1) * 58, 1080);

/**
 * The testers: stacks of three potatoes, one variety each. A new one hops in every few bugs, so the bug is never
 * on the same head for long. `crown` is how much the hat raises the top, for the bug to sit on.
 */
const TESTERS = [
    { name: "Russ", skin: "#c99a62", shade: "#a8763f", spot: "#7d5228" },
    { name: "Ruby", skin: "#c95a5f", shade: "#a6434a", spot: "#7e2c33", hat: "bow" },
    { name: "Sunny", skin: "#e0843f", shade: "#bf652a", spot: "#8a4320", hat: "sprout", crown: 8 },
    { name: "Violet", skin: "#8d6bb8", shade: "#6f4f9a", spot: "#4a3270" },
    {
        name: "Pip",
        skin: "#ecd08a",
        shade: "#d2ad62",
        spot: "#a8843e",
        hat: "beanie",
        beanie: "#1f8a78",
        crown: 12,
    },
];
/** The three potatoes in a stack, bottom up, in world units from the stack's foot. */
const TUBERS = [
    { y: -30, rx: 40, ry: 30, seed: 1.7 },
    { y: -82, rx: 33, ry: 27, seed: 4.1 },
    { y: HEAD_Y, rx: 29, ry: 28, seed: 2.6 },
];
/** How far sideways a point at height `y` moves when the stack leans: it leans from the bottom potato. */
const leanAt = (y) => stack.lean * (TUBERS[0].y - y);
const BUGS_PER_TESTER = 4;
const testerFor = (level) => Math.floor((level - 1) / BUGS_PER_TESTER) % TESTERS.length;
const tester = () => TESTERS[stack.who];

// ---------------------------------------------------------------- state

const game = {
    state: "title", // title | aim | flight | result | walk | over
    level: 1,
    score: 0,
    hearts: 3,
    spuds: 3,
    perfect: 0,
    timer: 0,
    time: 0,
    slow: 1,
    slowTarget: 1,
    wind: 0,
    recoil: 0,
    shake: 0,
    result: "",
    banner: 0,
    dusk: 0,
    whistle: 0,
};
const aim = {
    angle: (42 * Math.PI) / 180,
    power: 0.6,
    dragging: false,
    from: null,
    to: null,
    start: null,
};
const cam = { x: 300, y: -200, zoom: 0.7, mode: "frame" };
const stack = {
    who: 0,
    x: distanceFor(1),
    fromX: 0,
    toX: 0,
    base: distanceFor(1),
    sway: 0,
    swaySpeed: 0,
    mood: "calm", // calm | nervous | flinch | cheer | dizzy
    moodTimer: 0,
    blink: 0,
    nextBlink: 2,
    lean: 0,
    leanV: 0,
    hop: 0,
    hopV: 0,
    // The top potato, when a hit sends it flipping into the air: its height above its place, and its turn.
    popY: 0,
    popV: 0,
    popRot: 0,
    popSpin: 0,
    walking: false,
    speech: "",
    speechTimer: 0,
    near: 0,
};
const bug = {
    sev: "minor",
    on: true,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    rot: 0,
    spin: 0,
    scurry: 0,
    landing: false,
    taunt: "",
    tauntTimer: 0,
};
/**
 * The web's annoyances, floating between the cannon and the tester from bug 5: a new one every three bugs. A
 * potato bounces off them. The spinner circles; the rest bob up and down.
 */
const PESTS = {
    cookies: { w: 168, h: 48, round: false, hit: "Rejected all!", line: "Ugh, cookie banners." },
    chat: { w: 172, h: 50, round: false, hit: "Not now!", line: "Who turned the chat on?" },
    newsletter: { w: 150, h: 96, round: false, hit: "Unsubscribed!", line: "Not the newsletter…" },
    spinner: { w: 64, h: 64, round: true, hit: "Cancelled!", line: "Is it still loading?" },
};
const PEST_ORDER = ["cookies", "chat", "newsletter", "spinner"];
const pestFor = (level) => PEST_ORDER[Math.floor((level - 5) / 3) % PEST_ORDER.length];
const pest = {
    on: false,
    kind: "cookies",
    x: 0,
    y: 0,
    w: 168,
    h: 48,
    centre: 0,
    phase: 0,
    range: 0,
    wobble: 0,
    wobbleV: 0,
    appear: 1,
    fresh: false,
};
let potato = null;
let particles = [];
let streaks = [];
let floaters = [];
let rings = [];
let splats = [];
let spent = [];
let ghost = [];
let trailClock = 0;
const clouds = Array.from({ length: 7 }, (_, i) => ({
    x: i * 420 + rand(-80, 80),
    y: rand(0.07, 0.3),
    s: rand(0.75, 1.35),
}));

// ------------------------------------------------------------ the levels

function setUpLevel(level) {
    stack.base = distanceFor(level);
    bug.sev = severityFor(level);
    const windMax = level >= 3 ? Math.min((level - 2) * 42, 260) : 0;
    game.wind = windMax ? rand(windMax * 0.4, windMax) * (Math.random() < 0.5 ? -1 : 1) : 0;
    pest.on = level >= 5;
    if (pest.on) {
        const kind = pestFor(level);
        if (kind !== pest.kind || level === 5) {
            pest.appear = 0;
            pest.fresh = true;
        }
        pest.kind = kind;
        pest.w = PESTS[kind].w;
        pest.h = PESTS[kind].h;
        pest.centre = lerp(220, stack.base - 120, rand(0.25, 0.75));
        pest.x = pest.centre - pest.w / 2;
        pest.range = Math.min(50 + (level - 5) * 14, 120) * (kind === "newsletter" ? 0.7 : 1);
        pest.phase = rand(0, Math.PI * 2);
    }
    stack.sway = level >= 7 ? Math.min((level - 6) * 11, 56) : 0;
    stack.swaySpeed = level >= 7 ? Math.min(0.9 + (level - 7) * 0.16, 2.1) : 0;
}

/** How much of the flight the dotted guide shows: most of it at first, then only a hint. */
const guideTime = () => Math.max(0.16, 0.8 - (game.level - 1) * 0.07);
const windNumber = () => Math.round(Math.abs(game.wind) / 26);
const windLabel = () => (game.wind ? `${windNumber()} ${game.wind > 0 ? "→" : "←"}` : "calm");

function mood(next, seconds = 1.2) {
    stack.mood = next;
    stack.moodTimer = seconds;
}
function speak(text, seconds = 1.9) {
    stack.speech = text;
    stack.speechTimer = seconds;
}
function taunt(text) {
    bug.taunt = text;
    bug.tauntTimer = 1.4;
}

/** Sets a HUD number, with a little bump when it changes. */
function setHud(node, text) {
    if (node.textContent === text) return;
    node.textContent = text;
    node.classList.remove("bump");
    void node.offsetWidth;
    node.classList.add("bump");
}

function updateHud() {
    setHud(hud.score, String(game.score));
    setHud(hud.best, String(Math.max(best.value, game.score)));
    setHud(hud.spuds, String(game.spuds));
    setHud(hud.wind, windLabel());
    hud.hearts.innerHTML = `${"♥".repeat(game.hearts)}<i>${"♥".repeat(3 - game.hearts)}</i>`;
}

// ------------------------------------------------------------------ flow

function newGame() {
    Object.assign(game, {
        level: 1,
        score: 0,
        fixed: 0,
        hearts: 3,
        spuds: 3,
        perfect: 0,
        slow: 1,
        slowTarget: 1,
    });
    potato = null;
    particles = [];
    floaters = [];
    splats = [];
    spent = [];
    ghost = [];
    setUpLevel(1);
    stack.x = stack.base;
    stack.who = 0;
    Object.assign(stack, { popY: 0, popV: 0, popRot: 0 });
    stack.swapTo = undefined;
    stack.mood = "calm";
    stack.lean = 0;
    bug.on = true;
    bug.landing = false;
    startLevel();
    canvas.focus({ preventScroll: true });
}

function startLevel() {
    game.state = "aim";
    game.banner = 0.001;
    cam.mode = "frame";
    updateHud();
    sound.tone(523, 523, 0.1, "triangle", 0.06);
    sound.tone(784, 784, 0.16, "triangle", 0.06, 0.09);
    const lines = {
        1: "Get it off me!",
        3: "Bit breezy out here…",
        7: "Sorry, I'm fidgety.",
    };
    const pestLine = pest.on && pest.fresh ? PESTS[pest.kind].line : undefined;
    pest.fresh = false;
    const bySeverity = {
        blocker: "A blocker! Get it off!",
        nit: "Just a nit. A tiny one.",
        major: "That's a big one…",
    };
    const intro = stack.intro;
    stack.intro = undefined;
    speak(
        intro ??
            lines[game.level] ??
            pestLine ??
            bySeverity[bug.sev] ??
            pick(["Again!", "Another one!", "It's on me again!", "Quick!"]),
        2.2
    );
    const windWords = game.wind
        ? ` Wind ${windNumber()} to the ${game.wind > 0 ? "right" : "left"}.`
        : "";
    say(`Bug ${game.level}, a ${bug.sev}, ${Math.round(stack.base / METRE)} metres.${windWords}`);
}

function fire() {
    if (game.state !== "aim") return;
    sound.unlock();
    const speed = MIN_SPEED + aim.power * (MAX_SPEED - MIN_SPEED);
    const dx = Math.cos(aim.angle);
    const dy = -Math.sin(aim.angle);
    potato = {
        x: PIVOT.x + dx * BARREL,
        y: PIVOT.y + dy * BARREL,
        vx: dx * speed,
        vy: dy * speed,
        rot: 0,
        spin: rand(9, 15),
        seed: rand(0, 6),
        squash: 0,
        rolling: false,
    };
    ghost = [];
    trailClock = 0;
    game.spuds -= 1;
    game.recoil = 1;
    shake(0.22);
    buzz(15);
    game.state = "flight";
    cam.mode = "follow";
    game.banner = 0;
    updateHud();
    // Smoke, a flash and sparks at the muzzle.
    const mx = potato.x;
    const my = potato.y;
    for (let i = 0; i < 16; i++) {
        const a = aim.angle + rand(-0.6, 0.6);
        const s = rand(40, 260);
        particles.push({
            kind: "puff",
            x: mx,
            y: my,
            vx: Math.cos(a) * s,
            vy: -Math.sin(a) * s,
            r: rand(8, 16),
            grow: 28,
            color: "#f4f2ea",
            alpha: 0.95,
            life: rand(0.5, 1.1),
            max: 1.1,
            drag: 3,
            gravity: -40,
        });
    }
    for (let i = 0; i < 10; i++) {
        const a = aim.angle + rand(-0.35, 0.35);
        const s = rand(250, 520);
        particles.push({
            x: mx,
            y: my,
            vx: Math.cos(a) * s,
            vy: -Math.sin(a) * s,
            r: rand(1.8, 3),
            color: pick(["#ffd84d", "#ffb347"]),
            life: rand(0.2, 0.4),
            max: 0.4,
            drag: 2,
            gravity: 300,
        });
    }
    rings.push({ x: mx, y: my, r: 10, life: 0.12, max: 0.12, flash: true, angle: aim.angle });
    sound.tone(170, 42, 0.4, "sine", 0.55);
    sound.noise(0.45, 1500, 0.5, 0, 160);
    game.whistle = 0.35;
}

function endShot(kind) {
    game.state = "result";
    game.result = kind;
    game.timer = kind === "hit" ? 1.7 : kind === "ouch" ? 1.8 : 1.35;
    if (kind === "hit") {
        const firstTry = game.spuds === 2;
        const points = SEVERITY[bug.sev].points + (firstTry ? 1 : 0);
        game.score += points;
        game.fixed += 1;
        buzz(40);
        floaters.push({
            kind: "word",
            text: `+${points}`,
            x: bug.x - 50,
            y: bug.y - 20,
            vy: -40,
            life: 1.2,
            max: 1.2,
            color: "#ffffff",
        });
        game.perfect = firstTry ? game.perfect + 1 : 0;
        const fresh = best.offer(game.score);
        cam.mode = "focus";
        sound.tone(320, 980, 0.13, "square", 0.05);
        sound.chime(784, 0.07, 0.09);
        mood("cheer", 1.8);
        stack.hopV = -380;
        speak(pick(["Thank you!", "Fixed!", "My hero.", "Ship it!", "Resolved!", "Nice shot!"]));
        floaters.push({
            kind: "pill",
            text: "✓ Resolved",
            x: bug.x + 70,
            y: bug.y - 40,
            vy: -26,
            life: 1.6,
            max: 1.6,
        });
        if (firstTry && game.perfect >= 2)
            floaters.push({
                kind: "word",
                text: `${game.perfect} in a row!`,
                x: bug.x + 80,
                y: bug.y - 84,
                vy: -20,
                life: 1.5,
                max: 1.5,
                color: "#f4c56e",
            });
        else if (firstTry)
            floaters.push({
                kind: "word",
                text: "First spud!",
                x: bug.x + 80,
                y: bug.y - 84,
                vy: -20,
                life: 1.4,
                max: 1.4,
                color: "#f4c56e",
            });
        particles.push(...confetti(bug.x, bug.y, 46, 1.1));
        rings.push({ x: bug.x, y: bug.y, r: 12, life: 0.45, max: 0.45 });
        say(`Hit! ${points} points, ${game.score} in all.${fresh ? " New best." : ""}`);
    } else if (kind === "ouch") {
        game.hearts -= 1;
        game.perfect = 0;
        cam.mode = "focus";
        shake(0.5);
        sound.tone(560, 170, 0.28, "square", 0.08);
        sound.tone(240, 80, 0.45, "sawtooth", 0.06, 0.05);
        sound.noise(0.12, 1000, 0.35);
        mood("dizzy", 2);
        buzz([60, 40, 90]);
        stack.leanV = -7;
        // The top potato flips right off and lands back on, more or less.
        stack.popV = -560;
        stack.popSpin = ((Math.PI * 2 * GRAVITY) / (2 * 560)) * pick([-1, 1]);
        sound.tone(160, 620, 0.32, "sine", 0.09, 0.02);
        speak(
            game.hearts
                ? pick([
                      "Ouch! That's a regression.",
                      "OW. Filing a bug.",
                      "Not the face!",
                      "I've been mashed!",
                      "Mind the peel!",
                  ])
                : "That's it, I'm reverting you.",
            2.1
        );
        floaters.push({
            kind: "burst",
            text: "OUCH!",
            x: stack.x + 78,
            y: HEAD_Y - 24,
            vy: -16,
            life: 1.2,
            max: 1.2,
        });
        say(
            `Ouch, you hit ${tester().name}. ${game.hearts} heart${game.hearts === 1 ? "" : "s"} left.`
        );
    } else {
        game.perfect = 0;
        cam.mode = potato ? "land" : "frame";
        if (game.spuds === 0) {
            game.hearts -= 1;
            speak(game.hearts ? "Out of spuds! Reloading…" : "Out of spuds.", 1.9);
            say(`Out of potatoes. ${game.hearts} heart${game.hearts === 1 ? "" : "s"} left.`);
        } else {
            const near = potato && Math.abs(potato.x - stack.x) < 90;
            speak(
                near
                    ? pick(["Close!", "Whoa, close!", "Felt the breeze!"])
                    : pick(["Missed!", "Over here!", "Bit more?", "Try again!"]),
                1.5
            );
            say(`Missed. ${game.spuds} potato${game.spuds === 1 ? "" : "es"} left for this bug.`);
        }
        taunt(pick(["missed!", "nyah", "lol", "too slow"]));
        if (stack.mood !== "dizzy") mood("calm");
    }
    updateHud();
}

async function afterResult() {
    if (potato && potato.y > -POTATO_R * 3)
        spent.push({ x: potato.x, rot: potato.rot, seed: potato.seed });
    if (spent.length > 10) spent.shift();
    potato = null;
    if (game.result === "hit") {
        ghost = [];
        game.level += 1;
        game.spuds = 3;
        setUpLevel(game.level);
        stack.fromX = stack.x;
        stack.toX = stack.base;
        stack.walking = true;
        if (testerFor(game.level) !== stack.who) stack.swapTo = testerFor(game.level);
        game.state = "walk";
        game.timer = 0;
        cam.mode = "frame";
        updateHud();
        return;
    }
    if (game.hearts <= 0) {
        game.state = "over";
        cam.mode = "frame";
        for (const [i, f] of [392, 370, 349].entries())
            sound.tone(f, f * 0.97, 0.28, "sawtooth", 0.05, i * 0.3);
        sound.tone(330, 250, 0.8, "sawtooth", 0.05, 0.9);
        const fresh = game.score > 0 && game.score >= best.value;
        await showCard(stage, {
            kicker: "Game over",
            title: game.result === "ouch" ? `${tester().name} has had enough` : "Out of hearts",
            big: String(game.score),
            badge: fresh ? "New best" : undefined,
            text: [
                `points, from ${game.fixed} bug${game.fixed === 1 ? "" : "s"} fixed`,
                fresh || !best.value ? "" : `Your best is ${best.value}.`,
            ],
            button: "Play again",
            share: `I fixed ${game.fixed} bug${game.fixed === 1 ? "" : "s"} for ${game.score} points in Spud Cannon, a game from Notato.`,
        });
        newGame();
        return;
    }
    if (game.spuds === 0) game.spuds = 3;
    if (stack.mood === "dizzy") mood("calm");
    game.state = "aim";
    cam.mode = "frame";
    updateHud();
}

function shake(amount) {
    if (!reduceMotion.matches) game.shake = Math.max(game.shake, amount);
}

// ----------------------------------------------------------------- input

canvas.addEventListener("pointerdown", (event) => {
    if (game.state !== "aim") return;
    sound.unlock();
    canvas.setPointerCapture(event.pointerId);
    const p = local(event);
    aim.dragging = true;
    aim.from = p;
    aim.to = p;
    aim.start = { angle: aim.angle, power: aim.power };
});
canvas.addEventListener("pointermove", (event) => {
    if (!aim.dragging) return;
    aim.to = local(event);
    const px = aim.from.x - aim.to.x;
    const py = aim.from.y - aim.to.y;
    const length = Math.hypot(px, py);
    if (length < 8) {
        aim.angle = aim.start.angle;
        aim.power = aim.start.power;
        return;
    }
    // Pulling down and to the left fires up and to the right.
    let angle = Math.atan2(-py, px);
    if (px < 0) angle = py > 0 ? MIN_ANGLE : MAX_ANGLE;
    aim.angle = clamp(angle, MIN_ANGLE, MAX_ANGLE);
    aim.power = clamp(length / (Math.min(size.w, size.h) * 0.46), 0.04, 1);
});
const release = (event) => {
    if (!aim.dragging) return;
    aim.dragging = false;
    const moved = Math.hypot(aim.from.x - aim.to.x, aim.from.y - aim.to.y);
    if (event.type === "pointerup" && moved >= 8) fire();
    else if (event.type === "pointerup") speak("Drag back to aim!", 1.4);
};
canvas.addEventListener("pointerup", release);
canvas.addEventListener("pointercancel", release);

document.addEventListener("keydown", (event) => {
    if (game.state !== "aim" || event.target.closest?.("button, a, input")) return;
    const fine = event.shiftKey ? 0.25 : 1;
    const keys = {
        ArrowLeft: () => {
            aim.angle = clamp(aim.angle + 0.03 * fine, MIN_ANGLE, MAX_ANGLE);
        },
        ArrowRight: () => {
            aim.angle = clamp(aim.angle - 0.03 * fine, MIN_ANGLE, MAX_ANGLE);
        },
        ArrowUp: () => {
            aim.power = clamp(aim.power + 0.015 * fine, 0.04, 1);
        },
        ArrowDown: () => {
            aim.power = clamp(aim.power - 0.015 * fine, 0.04, 1);
        },
        " ": fire,
        Enter: fire,
    };
    const action = keys[event.key];
    if (!action) return;
    event.preventDefault();
    action();
});

// --------------------------------------------------------------- physics

function step(realDt) {
    game.slow = approach(game.slow, reduceMotion.matches ? 1 : game.slowTarget, 9, realDt);
    const dt = realDt * game.slow;
    game.time += dt;
    game.dusk = approach(
        game.dusk,
        Math.min(Math.floor((game.level - 1) / BUGS_PER_HOUR), SKIES.length - 1),
        0.7,
        realDt
    );
    game.recoil = Math.max(0, game.recoil - realDt * 3.5);
    game.shake = Math.max(0, game.shake - realDt * 1.4);
    if (game.banner > 0) game.banner += realDt;
    if (game.banner > 2.6) game.banner = 0;

    stepStack(dt);
    stepBug(dt);
    if (pest.on) {
        const t = game.time * 1.25 + pest.phase;
        pest.y = -235 - pest.h / 2 + 24 + Math.sin(t) * pest.range;
        pest.x =
            pest.centre -
            pest.w / 2 +
            (pest.kind === "spinner" ? Math.cos(t) * pest.range * 0.8 : 0);
        pest.wobbleV += (-pest.wobble * 180 - pest.wobbleV * 9) * dt;
        pest.wobble += pest.wobbleV * dt;
        pest.appear = Math.min(1, pest.appear + realDt * 2.2);
    }
    for (const cloud of clouds) {
        cloud.x += (14 + game.wind * 0.12) * dt * cloud.s;
        if (cloud.x > 2600) cloud.x -= 2900;
        if (cloud.x < -300) cloud.x += 2900;
    }

    if (game.state === "flight" && potato) {
        const steps = 6;
        for (let i = 0; i < steps && game.state === "flight"; i++) flightStep(dt / steps);
        trailClock += dt;
        if (potato && trailClock > 0.025) {
            trailClock = 0;
            ghost.push({ x: potato.x, y: potato.y });
            particles.push({
                kind: "puff",
                x: potato.x,
                y: potato.y,
                vx: 0,
                vy: 0,
                r: 4,
                grow: 14,
                color: "#ffffff",
                alpha: 0.55,
                life: 0.45,
                max: 0.45,
            });
        }
    } else if (game.state === "result") {
        if (potato) settlePotato(dt);
        game.timer -= realDt;
        if (game.timer < 1.2) game.slowTarget = 1;
        if (game.timer <= 0) afterResult();
    } else {
        game.slowTarget = 1;
    }

    particles = stepParticles(particles, dt);
    for (const s of streaks) {
        s.x += s.vx * realDt;
        s.life -= realDt;
    }
    streaks = streaks.filter((s) => s.life > 0 && s.x > -60 && s.x < size.w + 60);
    const windiness = Math.abs(game.wind) / 260;
    if (windiness && Math.random() < windiness * realDt * 22) {
        const dir = Math.sign(game.wind);
        streaks.push({
            x: dir > 0 ? rand(-40, size.w * 0.6) : rand(size.w * 0.4, size.w + 40),
            y: rand(size.h * 0.08, size.h * 0.8),
            vx: dir * rand(380, 620) * (0.5 + windiness),
            len: rand(30, 80) * (0.6 + windiness),
            life: rand(0.5, 1),
            max: 1,
        });
    }
    for (const f of floaters) {
        f.life -= realDt;
        f.y += f.vy * realDt;
    }
    floaters = floaters.filter((f) => f.life > 0);
    for (const r of rings) r.life -= realDt;
    rings = rings.filter((r) => r.life > 0);
    if (game.whistle > 0 && game.state === "flight") {
        game.whistle -= realDt;
        if (game.whistle <= 0) sound.tone(1500, 900, 0.9, "sine", 0.018);
    }
    stepCamera(realDt);
}

function stepStack(dt) {
    stack.moodTimer -= dt;
    stack.speechTimer -= dt;
    if (stack.moodTimer <= 0 && ["flinch", "cheer", "nervous"].includes(stack.mood))
        stack.mood = "calm";
    stack.nextBlink -= dt;
    if (stack.nextBlink <= 0) {
        stack.blink = 0.14;
        stack.nextBlink = rand(1.8, 4.5);
    }
    stack.blink = Math.max(0, stack.blink - dt);
    stack.leanV += (-stack.lean * 60 - stack.leanV * 7) * dt;
    stack.lean += stack.leanV * dt;
    if (stack.popY < 0 || stack.popV < 0) {
        stack.popV += GRAVITY * dt;
        stack.popY += stack.popV * dt;
        stack.popRot += stack.popSpin * dt;
        if (stack.popY >= 0) {
            stack.popY = 0;
            if (stack.popV > 140) {
                stack.popV = -stack.popV * 0.3;
                stack.leanV += stack.popSpin * 0.25;
                sound.tone(300, 180, 0.12, "triangle", 0.06);
            } else stack.popV = 0;
        }
    } else {
        // Settle upright, whichever way round it landed.
        const upright = Math.round(stack.popRot / (Math.PI * 2)) * Math.PI * 2;
        stack.popRot = approach(stack.popRot, upright, 10, dt);
    }
    stack.hopV += 1600 * dt;
    stack.hop = Math.min(0, stack.hop + stack.hopV * dt);
    if (stack.hop === 0) stack.hopV = 0;

    if (game.state === "walk") {
        game.timer += dt;
        let t = clamp(game.timer / 1.25, 0, 1);
        if (stack.swapTo !== undefined) {
            // One stack hops off; the next hops on from the right.
            const off = clamp(game.timer / 1.1, 0, 1);
            if (off < 1) {
                stack.x = lerp(stack.fromX, stack.fromX + 640, off * off);
                t = 0;
            } else {
                if (stack.who !== stack.swapTo) {
                    stack.who = stack.swapTo;
                    stack.fromX = stack.toX + 560;
                    stack.mood = "calm";
                }
                t = clamp((game.timer - 1.1) / 1.4, 0, 1);
                stack.x = lerp(stack.fromX, stack.toX, 1 - (1 - t) ** 2);
            }
        } else stack.x = lerp(stack.fromX, stack.toX, easeInOut(t));
        if (t >= 1 && stack.walking) {
            if (stack.swapTo !== undefined) {
                stack.swapTo = undefined;
                stack.intro = `${TESTERS[(stack.who + TESTERS.length - 1) % TESTERS.length].name} rolled home. I'm ${tester().name}!`;
                stack.hopV = -260;
            }
            stack.walking = false;
            bug.landing = true;
            bug.on = false;
            bug.x = stack.x + 160;
            bug.y = HEAD_Y - 240;
            bug.rot = 0;
        }
    } else if (stack.sway && game.state !== "result") {
        stack.x = stack.base + Math.sin(game.time * stack.swaySpeed) * stack.sway;
    }

    // Nervous when the aim, or the potato, comes near.
    if (game.state === "aim" && stack.mood === "calm" && previewNearStack() < 50)
        mood("nervous", 0.3);
    if (game.state === "flight" && potato) {
        const d = Math.hypot(potato.x - stack.x, potato.y - HEAD_Y);
        if (d < 110 && stack.mood !== "flinch") mood("flinch", 0.5);
        else if (d < 320 && stack.mood === "calm") mood("nervous", 0.6);
    }
}

function stepBug(dt) {
    bug.tauntTimer -= dt;
    if (bug.landing) {
        const home = bugHome();
        bug.x = approach(bug.x, home.x, 5, dt);
        bug.y = approach(bug.y, home.y, 5, dt);
        bug.rot = Math.sin(game.time * 22) * 0.3;
        if (Math.hypot(bug.x - home.x, bug.y - home.y) < 2) {
            bug.landing = false;
            bug.on = true;
            bug.rot = 0;
            startLevel();
        }
        return;
    }
    if (bug.on) {
        // It scurries about on top of the stack.
        bug.scurry += dt * SEVERITY[bug.sev].pace;
        const home = bugHome();
        bug.x = home.x;
        bug.y = home.y;
        bug.rot = home.rot;
        return;
    }
    bug.vy += GRAVITY * dt;
    bug.x += bug.vx * dt;
    bug.y += bug.vy * dt;
    bug.rot += bug.spin * dt;
}

function bugHome() {
    const wander = Math.sin(bug.scurry * 0.9) * 9 + Math.sin(bug.scurry * 2.3) * 3;
    const off = clamp(wander, -HEAD_R + 6, HEAD_R - 6);
    // Where it sits relative to the middle of the top potato, turned with it when it flips.
    const dx = off;
    const dy = -Math.sqrt(HEAD_R * HEAD_R - off * off) - (tester().crown ?? 0) - bugSize() + 3;
    const c = Math.cos(stack.popRot);
    const s = Math.sin(stack.popRot);
    return {
        x: stack.x + leanAt(HEAD_Y) + dx * c - dy * s,
        y: HEAD_Y + stack.hop + stack.popY + dx * s + dy * c,
        rot: Math.asin(off / HEAD_R) * 0.9 + stack.popRot,
    };
}

function flightStep(dt) {
    const p = potato;
    p.vx += game.wind * dt;
    p.vy += GRAVITY * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.rot += p.spin * dt;

    // Slow motion as it closes on the bug.
    const toBug = Math.hypot(p.x - bug.x, p.y - bug.y);
    const closing = (bug.x - p.x) * p.vx + (bug.y - p.y) * p.vy > 0;
    game.slowTarget = bug.on && toBug < 130 && closing ? 0.3 : 1;

    if (bug.on && toBug < POTATO_R + bugSize()) {
        bug.on = false;
        bug.vx = p.vx * 0.5 + 90;
        bug.vy = Math.min(p.vy * 0.3, 0) - 460;
        bug.spin = rand(14, 20) * (p.vx > 0 ? 1 : -1);
        p.vx *= -0.25;
        p.vy = -Math.abs(p.vy) * 0.3 - 120;
        game.slowTarget = 0.25;
        shake(0.18);
        endShot("hit");
        return;
    }
    if (hitsStack(p)) {
        p.vx = -Math.abs(p.vx) * 0.3 - 60;
        p.vy = -260;
        game.slowTarget = 1;
        for (let i = 0; i < 10; i++)
            particles.push({
                x: p.x,
                y: p.y,
                vx: rand(-200, 200),
                vy: rand(-300, 0),
                r: rand(2, 4),
                color: pick(["#ffd84d", "#fff3c4"]),
                life: 0.6,
                max: 0.6,
                gravity: 600,
            });
        endShot("ouch");
        return;
    }
    if (pest.on && bounceOffPest(p)) {
        sound.tone(1300, 1250, 0.12, "triangle", 0.07);
        sound.tone(1950, 1900, 0.1, "sine", 0.05, 0.03);
        floaters.push({
            kind: "word",
            text: PESTS[pest.kind].hit,
            x: p.x,
            y: p.y - 30,
            vy: -30,
            life: 0.9,
            max: 0.9,
            color: "#45bfa8",
        });
    }
    if (p.y >= -POTATO_R) {
        p.y = -POTATO_R;
        splat(p.x, p.vx);
        p.vy = -Math.abs(p.vy) * 0.25;
        p.vx *= 0.45;
        p.rolling = true;
        endShot("miss");
        return;
    }
    if (p.x > stack.base + 900 || p.x < -500) {
        potato = null;
        endShot("miss");
    }
}

/** After a shot: a potato that bounced off something falls, bounces and rolls to a stop. */
function settlePotato(dt) {
    const p = potato;
    p.vy += GRAVITY * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    if (p.y >= -POTATO_R) {
        p.y = -POTATO_R;
        if (Math.abs(p.vy) > 120) {
            p.vy = -Math.abs(p.vy) * 0.3;
            p.squash = 0.25;
        } else p.vy = 0;
        p.vx *= Math.exp(-2.4 * dt);
        p.rot += (p.vx / (POTATO_R * 1.1)) * dt;
    } else p.rot += p.spin * dt;
    p.squash = approach(p.squash, 0, 10, dt);
}

function hitsStack(p) {
    for (const t of TUBERS) {
        const dx = p.x - (stack.x + leanAt(t.y));
        const dy = p.y - (t.y + stack.hop);
        const rx = t.rx + POTATO_R - 3;
        const ry = t.ry + POTATO_R - 3;
        if ((dx / rx) ** 2 + (dy / ry) ** 2 < 1) return true;
    }
    return false;
}

function bounceOffPest(p) {
    let cx = clamp(p.x, pest.x, pest.x + pest.w);
    let cy = clamp(p.y, pest.y, pest.y + pest.h);
    if (PESTS[pest.kind].round) {
        // The nearest point on a disc.
        const r = pest.w / 2;
        const ox = p.x - (pest.x + r);
        const oy = p.y - (pest.y + r);
        const od = Math.hypot(ox, oy) || 1;
        cx = pest.x + r + (ox / od) * Math.min(od, r);
        cy = pest.y + r + (oy / od) * Math.min(od, r);
    }
    const dx = p.x - cx;
    const dy = p.y - cy;
    const d = Math.hypot(dx, dy);
    if (d >= POTATO_R) return false;
    const nx = d ? dx / d : 0;
    const ny = d ? dy / d : p.vy > 0 ? -1 : 1;
    p.x = cx + nx * POTATO_R;
    p.y = cy + ny * POTATO_R;
    const dot = p.vx * nx + p.vy * ny;
    if (dot >= 0) return false;
    p.vx = (p.vx - 2 * dot * nx) * 0.6;
    p.vy = (p.vy - 2 * dot * ny) * 0.6;
    pest.wobbleV += (p.vx > 0 ? 1 : -1) * 3;
    return true;
}

function splat(x, vx) {
    splats.push({ x, r: rand(16, 24), seed: rand(0, 10) });
    if (splats.length > 14) splats.shift();
    shake(0.12);
    sound.noise(0.28, 900, 0.5, 0, 140);
    sound.tone(130, 55, 0.18, "sine", 0.35);
    for (let i = 0; i < 18; i++) {
        const a = rand(-Math.PI * 0.95, -Math.PI * 0.05);
        const s = rand(90, 320);
        particles.push({
            x,
            y: -4,
            vx: Math.cos(a) * s + vx * 0.15,
            vy: Math.sin(a) * s,
            r: rand(2, 4.5),
            color: pick(["#8c6a45", "#6f5236", "#f6e3c4", "#e9c68c"]),
            life: rand(0.5, 0.9),
            max: 0.9,
            gravity: 900,
        });
    }
    for (let i = 0; i < 6; i++)
        particles.push({
            kind: "puff",
            x: x + rand(-14, 14),
            y: -6,
            vx: rand(-40, 40),
            vy: rand(-50, -10),
            r: rand(6, 10),
            grow: 20,
            color: "#d9c3a0",
            alpha: 0.7,
            life: 0.7,
            max: 0.7,
            drag: 2,
        });
}

/** Where a potato fired now would fly, as points, for `seconds` (or until it lands). */
function simulate(seconds, every = 1) {
    const speed = MIN_SPEED + aim.power * (MAX_SPEED - MIN_SPEED);
    let x = PIVOT.x + Math.cos(aim.angle) * BARREL;
    let y = PIVOT.y - Math.sin(aim.angle) * BARREL;
    let vx = Math.cos(aim.angle) * speed;
    let vy = -Math.sin(aim.angle) * speed;
    const points = [];
    const dt = 1 / 60;
    let i = 0;
    for (let t = 0; t < seconds; t += dt, i++) {
        vx += game.wind * dt;
        vy += GRAVITY * dt;
        x += vx * dt;
        y += vy * dt;
        if (i % every === 0) points.push({ x, y, t: t / seconds });
        if (y > 0) break;
    }
    return points;
}

/** How close the shot being aimed would pass to the stack (a line from its foot to its top). */
function previewNearStack() {
    const top = HEAD_Y - HEAD_R;
    let nearest = Infinity;
    for (const p of simulate(3, 1)) {
        const dy = p.y < top ? top - p.y : 0;
        nearest = Math.min(nearest, Math.hypot(p.x - stack.x, dy));
    }
    return nearest;
}

// ---------------------------------------------------------------- camera

const groundAnchor = (zoom) => -(size.h * 0.35) / zoom;

/** What the camera keeps in view while aiming: the cannon, to just past the stack. */
const FRAME_LEFT = -105;
const FRAME_RIGHT = 115;

function frameZoom() {
    const left = FRAME_LEFT;
    const right = stack.base + stack.sway + FRAME_RIGHT;
    return Math.min(size.w / (right - left), (size.h * 0.82) / 470, 1.5);
}

function stepCamera(dt) {
    const fz = frameZoom();
    let zoom = fz;
    let x = (FRAME_LEFT + stack.base + stack.sway + FRAME_RIGHT) / 2;
    let y;
    let rate = 3.2;
    if (cam.mode === "follow" && potato) {
        zoom = Math.max(fz, Math.min(size.w / 760, fz * 1.5));
        x = potato.x + potato.vx * 0.12;
        y = Math.min(groundAnchor(zoom), potato.y + (size.h * 0.12) / zoom);
        rate = 5;
    } else if (cam.mode === "land" && potato) {
        zoom = Math.max(fz, Math.min(size.w / 700, fz * 1.4));
        x = potato.x;
        rate = 4;
    } else if (cam.mode === "focus") {
        zoom = Math.min(fz * 1.9, size.w / 520, (size.h * 0.8) / 330);
        zoom = Math.max(zoom, fz);
        x = stack.x - 20;
        y = Math.min(groundAnchor(zoom), -(size.h * 0.18) / zoom - 120);
        rate = 4;
    }
    y ??= groundAnchor(zoom);
    if (reduceMotion.matches) rate = 30;
    cam.zoom = Math.exp(approach(Math.log(cam.zoom), Math.log(zoom), rate, dt));
    cam.x = approach(cam.x, x, rate, dt);
    cam.y = approach(cam.y, y, rate, dt);
}

function snapCamera() {
    cam.mode = "frame";
    cam.zoom = frameZoom();
    cam.x = (FRAME_LEFT + stack.base + stack.sway + FRAME_RIGHT) / 2;
    cam.y = groundAnchor(cam.zoom);
}

const toScreenX = (x) => (x - cam.x) * cam.zoom + size.w / 2;
const toScreenY = (y) => (y - cam.y) * cam.zoom + size.h / 2;

// --------------------------------------------------------------- drawing

function draw() {
    begin();
    const sx = game.shake ? rand(-1, 1) * game.shake * 18 : 0;
    const sy = game.shake ? rand(-1, 1) * game.shake * 12 : 0;
    ctx.save();
    ctx.translate(sx, sy);
    drawSky();
    drawFarLayers();
    const now = skyNow();
    ctx.fillStyle = now.haze;
    ctx.fillRect(-40, -40, size.w + 80, size.h + 80);

    // The world.
    ctx.save();
    const k = cam.zoom;
    ctx.translate(size.w / 2 - cam.x * k, size.h / 2 - cam.y * k);
    ctx.scale(k, k);
    drawGround();
    drawSigns();
    for (const s of splats) drawSplat(s);
    for (const s of spent) drawPotato(ctx, s.x, -POTATO_R + 2, POTATO_R, s.rot, s.seed);
    if (ghost.length > 1 && game.state === "aim") drawGhost();
    drawFlag();
    drawStack();
    if (pest.on) drawPest();
    drawCannon();
    if (game.state === "aim") drawGuide();
    if (potato) {
        drawPotato(ctx, potato.x, potato.y, POTATO_R, potato.rot, potato.seed, potato.squash);
    }
    // Evening light over the scene, then the things that are read: bubbles and words stay bright.
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = now.shade;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    if (now.night > 0) drawFireflies(now.night);
    // The bug is the target, so it stays in full light whatever the time of day.
    if (bug.on || bug.landing || bug.y < 200) drawBug();
    drawParticles(ctx, particles);
    for (const r of rings) drawRing(r);
    if (stack.speechTimer > 0 && stack.speech) drawSpeech();
    if (bug.tauntTimer > 0 && bug.taunt && bug.on) drawTaunt();
    for (const f of floaters) drawFloater(f);
    ctx.restore();

    drawStreaks();
    if (potato && toScreenY(potato.y) < -6) drawOffscreen();
    if (game.state === "aim" && aim.dragging) drawPull();
    if (game.state === "aim") drawAimReadout();
    if (game.banner > 0) drawBanner();
    ctx.restore();
}

function drawSky() {
    const now = skyNow();
    const sky = ctx.createLinearGradient(0, 0, 0, size.h);
    sky.addColorStop(0, now.top);
    sky.addColorStop(0.65, now.mid);
    sky.addColorStop(1, now.low);
    ctx.fillStyle = sky;
    ctx.fillRect(-40, -40, size.w + 80, size.h + 80);
    if (now.night > 0) {
        for (const s of stars) {
            ctx.globalAlpha = now.night * (0.55 + Math.sin(game.time * 2 + s.p) * 0.45);
            circle(ctx, s.x * size.w, s.y * size.h, s.r);
            ctx.fillStyle = "#ffffff";
            ctx.fill();
        }
        ctx.globalAlpha = 1;
    }
    // The sun, with slowly turning rays; at night, the moon.
    const sunX = size.w * 0.82 - cam.x * cam.zoom * 0.03;
    const sunY = size.h * now.sunY;
    const r = Math.min(size.w, size.h) * 0.075;
    if (now.night > 0.5) {
        circle(ctx, sunX, sunY, r * 1.9);
        ctx.fillStyle = "rgba(220, 225, 255, 0.12)";
        ctx.fill();
        circle(ctx, sunX, sunY, r);
        ctx.fillStyle = now.sun;
        ctx.fill();
        ctx.fillStyle = "rgba(120, 125, 150, 0.25)";
        for (const [cx, cy, cr] of [
            [-0.3, -0.2, 0.22],
            [0.25, 0.15, 0.3],
            [0.1, -0.45, 0.12],
        ]) {
            circle(ctx, sunX + cx * r, sunY + cy * r, cr * r);
            ctx.fill();
        }
        drawClouds(now);
        return;
    }
    ctx.save();
    ctx.translate(sunX, sunY);
    ctx.rotate(game.time * 0.05);
    const rays = ctx.createRadialGradient(0, 0, r, 0, 0, r * 3.6);
    rays.addColorStop(0, "rgba(255, 246, 210, 0.32)");
    rays.addColorStop(1, "rgba(255, 246, 210, 0)");
    ctx.fillStyle = rays;
    for (let i = 0; i < 12; i++) {
        ctx.rotate(Math.PI / 6);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(r * 3.6, -r * 0.3);
        ctx.lineTo(r * 3.6, r * 0.3);
        ctx.fill();
    }
    ctx.restore();
    circle(ctx, sunX, sunY, r * 1.5);
    ctx.fillStyle = "rgba(255, 244, 200, 0.5)";
    ctx.fill();
    circle(ctx, sunX, sunY, r);
    ctx.fillStyle = now.sun;
    ctx.fill();
    drawClouds(now);
}

/** Clouds drift with the wind and slide a little as the camera pans. */
function drawClouds(now) {
    const span = size.w + 400;
    for (const c of clouds) {
        const x = c.x * 0.5 - cam.x * cam.zoom * 0.08;
        const scale = c.s * clamp(size.w / 900, 0.55, 1.2);
        drawCloud((((x % span) + span) % span) - 200, size.h * c.y, scale, now.cloud);
    }
}

function drawCloud(x, y, s, colour) {
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.ellipse(x, y, 70 * s, 22 * s, 0, 0, Math.PI * 2);
    ctx.ellipse(x - 36 * s, y + 2 * s, 38 * s, 20 * s, 0, 0, Math.PI * 2);
    ctx.ellipse(x + 10 * s, y - 18 * s, 40 * s, 30 * s, 0, 0, Math.PI * 2);
    ctx.ellipse(x + 44 * s, y - 4 * s, 30 * s, 20 * s, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = "rgba(190, 220, 230, 0.35)";
    ctx.beginPath();
    ctx.ellipse(x + 4 * s, y + 12 * s, 66 * s, 9 * s, 0, 0, Math.PI * 2);
    ctx.fill();
}

/** A ridge of scenery that moves `depth` as fast as the ground (0 = never, 1 = with it). */
function ridge(depth, lift, height, color, seed, freq) {
    const gy = toScreenY(0);
    const scale = cam.zoom * (0.55 + depth * 0.45);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(-10, size.h + 10);
    for (let x = -10; x <= size.w + 10; x += 6) {
        const wx = (x - size.w / 2) / scale + cam.x * depth;
        const h =
            height *
            (0.55 +
                0.25 * Math.sin(wx * freq + seed) +
                0.14 * Math.sin(wx * freq * 2.7 + seed * 3) +
                0.06 * Math.sin(wx * freq * 6.1 + seed));
        ctx.lineTo(x, gy - (lift + h) * scale);
    }
    ctx.lineTo(size.w + 10, size.h + 10);
    ctx.fill();
    return scale;
}

function drawFarLayers() {
    ridge(0.18, 40, 330, "#b9d9d3", 1.3, 0.0021);
    ridge(0.35, 20, 190, "#a3cfb4", 4.1, 0.0035);
    // Rolling hills with round trees on them.
    const scale = ridge(0.6, 0, 90, "#8cc59a", 2.2, 0.006);
    const gy = toScreenY(0);
    const depth = 0.6;
    const left = cam.x * depth - size.w / 2 / scale - 100;
    const right = cam.x * depth + size.w / 2 / scale + 100;
    for (let i = Math.floor(left / 130); i <= right / 130; i++) {
        const r = seeded(i * 7919 + 13);
        if (r() < 0.35) continue;
        const wx = i * 130 + r() * 70;
        const x = (wx - cam.x * depth) * scale + size.w / 2;
        const hill =
            90 *
            (0.55 +
                0.25 * Math.sin(wx * 0.006 + 2.2) +
                0.14 * Math.sin(wx * 0.006 * 2.7 + 6.6) +
                0.06 * Math.sin(wx * 0.006 * 6.1 + 2.2));
        const y = gy - hill * scale;
        const t = (24 + r() * 18) * scale;
        ctx.fillStyle = "#6a9f73";
        ctx.fillRect(x - t * 0.09, y - t * 0.6, t * 0.18, t * 0.8);
        circle(ctx, x, y - t * 1.05, t * 0.62);
        ctx.fillStyle = r() < 0.5 ? "#79b383" : "#6fab7b";
        ctx.fill();
    }
}

function drawGround() {
    const left = cam.x - size.w / 2 / cam.zoom - 60;
    const right = cam.x + size.w / 2 / cam.zoom + 60;
    const bottom = cam.y + size.h / 2 / cam.zoom + 40;
    // A hedge behind the scene: the top of a row of overlapping bushes, as one outline.
    const bush = (i) => {
        const r = seeded(Math.abs(i) * 31 + 5);
        return { x: i * 46 + r() * 16, y: -14 - r() * 12, r: 26 + r() * 12 };
    };
    ctx.beginPath();
    ctx.moveTo(left, 0);
    for (let x = left; x <= right + 6; x += 6) {
        let top = -8;
        const i = Math.floor(x / 46);
        for (let j = i - 2; j <= i + 2; j++) {
            const b = bush(j);
            const dx = x - b.x;
            if (Math.abs(dx) < b.r) top = Math.min(top, b.y - Math.sqrt(b.r * b.r - dx * dx));
        }
        ctx.lineTo(x, top);
    }
    ctx.lineTo(right + 6, 0);
    ctx.closePath();
    inked(ctx, "#79bd70", 2.5);
    ctx.fillStyle = "#8fcb7f";
    for (let i = Math.floor(left / 46) - 1; i <= right / 46 + 1; i++) {
        const b = bush(i);
        ctx.beginPath();
        ctx.ellipse(
            b.x - b.r * 0.3,
            b.y - b.r * 0.55,
            b.r * 0.32,
            b.r * 0.16,
            -0.4,
            0,
            Math.PI * 2
        );
        ctx.fill();
    }
    // Grass and soil.
    ctx.fillStyle = "#9b7149";
    ctx.fillRect(left, 0, right - left, bottom);
    ctx.fillStyle = "#86603c";
    for (let x = Math.floor(left / 60) * 60; x < right; x += 60) {
        const r = seeded(Math.abs(Math.floor(x / 60)) * 17 + 3);
        ctx.beginPath();
        ctx.ellipse(x + r() * 40, 34 + r() * 50, 7 + r() * 6, 4 + r() * 2, 0, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.beginPath();
    ctx.moveTo(left, 0);
    ctx.lineTo(right, 0);
    ctx.lineTo(right, 16);
    for (let x = right; x > left; x -= 22) ctx.quadraticCurveTo(x - 11, 26, x - 22, 16);
    ctx.closePath();
    inked(ctx, "#7cc36a", 3);
    ctx.strokeStyle = "#5e9f52";
    ctx.lineWidth = 2;
    for (let x = Math.floor(left / 26) * 26; x < right; x += 26) {
        const r = seeded(Math.abs(Math.floor(x / 26)) * 13 + 1);
        if (r() < 0.4) continue;
        const gx = x + r() * 20;
        ctx.beginPath();
        ctx.moveTo(gx - 4, 1);
        ctx.lineTo(gx - 6, -7);
        ctx.moveTo(gx, 1);
        ctx.lineTo(gx + 1, -10);
        ctx.moveTo(gx + 4, 1);
        ctx.lineTo(gx + 7, -6);
        ctx.stroke();
    }
}

function drawSigns() {
    ctx.font = "700 15px 'JetBrains Mono', monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let m = 5; m * METRE < stack.base + 600; m += 5) {
        const x = m * METRE;
        inkedLine(
            ctx,
            [
                [x, 0],
                [x, -34],
            ],
            "#b07a45",
            5,
            2.5
        );
        roundRect(ctx, x - 26, -58, 52, 26, 5);
        inked(ctx, "#f6e3c4", 2.5);
        ctx.fillStyle = INK;
        ctx.fillText(`${m} m`, x, -44.5);
    }
}

function drawSplat(s) {
    const r = seeded(Math.floor(s.seed * 1000));
    ctx.fillStyle = "#f3dfae";
    ctx.beginPath();
    for (let i = 0; i <= 14; i++) {
        const a = Math.PI + (i / 14) * Math.PI;
        const rr = s.r * (0.7 + r() * 0.5);
        ctx.lineTo(s.x + Math.cos(a) * rr * 1.4, 2 + Math.sin(a) * rr * 0.5);
    }
    ctx.closePath();
    inked(ctx, "#f3dfae", 2);
    for (let i = 0; i < 4; i++) {
        circle(ctx, s.x + (r() - 0.5) * s.r * 3, -2 - r() * 6, 1.8 + r() * 2);
        ctx.fillStyle = "#b97a35";
        ctx.fill();
    }
}

function drawGhost() {
    ctx.setLineDash([2, 10]);
    ctx.lineCap = "round";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(35, 38, 43, 0.22)";
    ctx.beginPath();
    for (const [i, p] of ghost.entries()) {
        if (i) ctx.lineTo(p.x, p.y);
        else ctx.moveTo(p.x, p.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
}

function drawGuide() {
    const points = simulate(guideTime(), 4);
    points.forEach((p, i) => {
        if (i === 0) return;
        const fade = 1 - p.t;
        circle(ctx, p.x, p.y, 3 + fade * 3);
        ctx.fillStyle = `rgba(255, 255, 255, ${0.35 + fade * 0.6})`;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = `rgba(35, 38, 43, ${0.2 + fade * 0.6})`;
        ctx.stroke();
    });
}

function drawFlag() {
    const x = Math.max(250, stack.base * 0.42);
    const top = -150;
    inkedLine(
        ctx,
        [
            [x, 0],
            [x, top],
        ],
        "#cfd3d8",
        5,
        2.5
    );
    circle(ctx, x, top - 4, 6);
    inked(ctx, "#f4c56e", 2.5);
    const strength = clamp(Math.abs(game.wind) / 260, 0, 1);
    const dir = Math.sign(game.wind) || 1;
    const length = 30 + strength * 46;
    const droop = (1 - strength) * 40;
    const wave = Math.sin(game.time * (4 + strength * 12)) * (2 + strength * 5);
    ctx.beginPath();
    ctx.moveTo(x, top + 2);
    ctx.quadraticCurveTo(
        x + dir * length * 0.5,
        top + 2 + wave,
        x + dir * length,
        top + 8 + droop + wave
    );
    ctx.lineTo(x + dir * length * 0.92, top + 26 + droop - wave * 0.5);
    ctx.quadraticCurveTo(x + dir * length * 0.5, top + 28 + droop * 0.5 - wave, x, top + 30);
    ctx.closePath();
    inked(ctx, "#e5484d", 2.5);
}

function drawCannon() {
    const recoil = game.recoil * 14;
    // A crate of spuds.
    roundRect(ctx, 42, -40, 66, 40, 5);
    inked(ctx, "#c48a52", 2.5);
    ctx.strokeStyle = "#8f6136";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(46, -20);
    ctx.lineTo(104, -20);
    ctx.stroke();
    for (let i = 0; i < game.spuds; i++)
        drawPotato(ctx, 56 + i * 19, -44 - (i % 2) * 3, 9, i * 0.7, i + 1);

    // Carriage.
    ctx.beginPath();
    ctx.moveTo(-40, -18);
    ctx.lineTo(28, -18);
    ctx.lineTo(14, -56);
    ctx.lineTo(-22, -56);
    ctx.closePath();
    inked(ctx, "#b07a45", 3);

    // Barrel.
    ctx.save();
    ctx.translate(PIVOT.x, PIVOT.y);
    ctx.rotate(-aim.angle);
    ctx.translate(-recoil, 0);
    roundRect(ctx, -30, -19, BARREL + 30, 38, 14);
    inked(ctx, "#5b6773", 3);
    ctx.fillStyle = "rgba(255, 255, 255, 0.22)";
    roundRect(ctx, -20, -13, BARREL + 8, 7, 4);
    ctx.fill();
    for (const bx of [6, BARREL - 26]) {
        roundRect(ctx, bx, -20, 10, 40, 3);
        inked(ctx, "#e0a24a", 2.5);
    }
    roundRect(ctx, BARREL - 8, -23, 14, 46, 6);
    inked(ctx, "#47515c", 3);
    ctx.restore();

    // Wheel.
    const spin = -game.recoil * 1.2;
    circle(ctx, PIVOT.x, -30, 30);
    inked(ctx, "#3a3f46", 3);
    circle(ctx, PIVOT.x, -30, 22);
    ctx.fillStyle = "#c48a52";
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 3;
    for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + spin;
        ctx.beginPath();
        ctx.moveTo(PIVOT.x, -30);
        ctx.lineTo(PIVOT.x + Math.cos(a) * 22, -30 + Math.sin(a) * 22);
        ctx.stroke();
    }
    circle(ctx, PIVOT.x, -30, 7);
    inked(ctx, "#e0a24a", 2.5);

    // Power, round the wheel, while aiming.
    if (game.state === "aim") {
        ctx.lineCap = "round";
        ctx.lineWidth = 7;
        ctx.strokeStyle = "rgba(35, 38, 43, 0.2)";
        ctx.beginPath();
        ctx.arc(PIVOT.x, PIVOT.y, 62, -Math.PI * 0.97, -Math.PI * 0.03);
        ctx.stroke();
        ctx.strokeStyle = aim.power > 0.85 ? "#e5484d" : aim.power > 0.6 ? "#f4c56e" : "#45bfa8";
        ctx.beginPath();
        ctx.arc(
            PIVOT.x,
            PIVOT.y,
            62,
            -Math.PI * 0.97,
            -Math.PI * 0.97 + Math.PI * 0.94 * aim.power
        );
        ctx.stroke();
    }
}

function drawStack() {
    const look = TESTERS[stack.who];
    const x = stack.x;
    // Hopping along when it moves, with a squash as it lands.
    const hopT = stack.walking ? Math.abs(Math.sin(game.time * 9)) : 0;
    const bounce = stack.hop - hopT * 18;
    const squash = stack.walking ? (1 - hopT) ** 4 * 0.12 : 0;
    const breathe = Math.sin(game.time * 2.2) * 1.2;
    const knock =
        stack.mood === "nervous" || stack.mood === "flinch" ? Math.sin(game.time * 50) * 1.2 : 0;

    // Shadow.
    ctx.fillStyle = "rgba(35, 38, 43, 0.16)";
    ctx.beginPath();
    ctx.ellipse(x, 2, 44 - hopT * 8, 8, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.save();
    ctx.translate(x, bounce);
    ctx.scale(1 + squash, 1 - squash);
    const [bottom, middle, top] = TUBERS;
    tuber(bottom, look);
    drawBottomFace(bottom);

    // The rest leans from the bottom potato, the top a little behind the middle, like jelly.
    ctx.translate(0, bottom.y);
    ctx.rotate(stack.lean);
    ctx.translate(0, -bottom.y);
    const wobble = stack.walking ? Math.sin(game.time * 9 + 1) * 2 : 0;
    ctx.save();
    ctx.translate(wobble * 0.5 + knock * 0.5, breathe * 0.4);
    drawArms(middle, "back");
    tuber(middle, look);
    // A note stuck on, as every tester has.
    ctx.save();
    ctx.translate(-12, middle.y + 2);
    ctx.rotate(-0.12);
    roundRect(ctx, -9, -9, 18, 18, 2);
    inked(ctx, "#fde29a", 2);
    ctx.fillStyle = "rgba(35, 38, 43, 0.4)";
    ctx.fillRect(-5, -4, 10, 1.6);
    ctx.fillRect(-5, 0, 8, 1.6);
    ctx.fillRect(-5, 4, 9, 1.6);
    ctx.restore();
    drawMiddleFace(middle);
    drawArms(middle, "front");
    ctx.restore();

    ctx.translate(wobble + knock, breathe + stack.popY);
    ctx.translate(0, top.y);
    ctx.rotate(stack.popRot);
    ctx.translate(0, -top.y);
    if (look.hat === "bow") drawBow(top);
    tuber(top, look);
    drawTopFace(top);
    if (look.hat === "sprout") drawSprout(top);
    if (look.hat === "beanie") drawBeanie(top, look);
    ctx.restore();
}

/** One potato of the stack: lumpy, outlined, shaded, with a few eyes (the potato kind). */
function tuber(t, look) {
    const shape = () => {
        ctx.beginPath();
        for (let i = 0; i <= 22; i++) {
            const a = (i / 22) * Math.PI * 2;
            const w = 1 + Math.sin(a * 3 + t.seed) * 0.05 + Math.sin(a * 5 + t.seed * 2.3) * 0.03;
            const px = Math.cos(a) * t.rx * w;
            const py = t.y + Math.sin(a) * t.ry * w;
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
        }
        ctx.closePath();
    };
    shape();
    inked(ctx, look.skin, 3);
    ctx.save();
    shape();
    ctx.clip();
    ctx.fillStyle = look.shade;
    ctx.beginPath();
    ctx.ellipse(t.rx * 0.25, t.y + t.ry * 0.62, t.rx * 1.2, t.ry * 0.55, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = "rgba(255, 245, 225, 0.45)";
    ctx.beginPath();
    ctx.ellipse(-t.rx * 0.45, t.y - t.ry * 0.5, t.rx * 0.32, t.ry * 0.14, -0.35, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = look.spot;
    for (const [ex, ey] of [
        [0.62, -0.2],
        [-0.7, 0.3],
        [0.5, 0.45],
    ]) {
        ctx.beginPath();
        ctx.ellipse(ex * t.rx, t.y + ey * t.ry, 2.6, 1.8, t.seed, 0, Math.PI * 2);
        ctx.fill();
    }
}

/** The bottom potato holds everyone up, and its face says so. */
function drawBottomFace(t) {
    const y = t.y - 2;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (stack.mood === "cheer") {
        for (const side of [-1, 1]) {
            ctx.beginPath();
            ctx.arc(side * 11, y + 2, 4, Math.PI * 1.1, Math.PI * 1.9);
            ctx.stroke();
        }
        ctx.beginPath();
        ctx.arc(0, y + 8, 5, 0.15 * Math.PI, 0.85 * Math.PI);
        ctx.stroke();
        return;
    }
    // Squeezed shut: > <
    for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(side * 11 - side * 4, y - 4);
        ctx.lineTo(side * 11 + side * 2, y);
        ctx.lineTo(side * 11 - side * 4, y + 4);
        ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(-6, y + 11);
    for (let i = 1; i <= 4; i++) ctx.lineTo(-6 + i * 3, y + 11 + (i % 2 ? -1.5 : 1));
    ctx.stroke();
}

/** The middle potato just looks at you, mostly. */
function drawMiddleFace(t) {
    const y = t.y - 3;
    const scared = stack.mood === "nervous" || stack.mood === "flinch";
    for (const side of [-1, 1]) {
        if (stack.blink > 0 || stack.mood === "flinch") {
            ctx.strokeStyle = INK;
            ctx.lineWidth = 2.5;
            ctx.beginPath();
            ctx.moveTo(10 + side * 7 - 3, y);
            ctx.lineTo(10 + side * 7 + 3, y);
            ctx.stroke();
        } else {
            circle(ctx, 10 + side * 7, y, scared ? 3 : 2.4);
            ctx.fillStyle = INK;
            ctx.fill();
        }
    }
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    if (scared) {
        circle(ctx, 10, y + 9, 2.8);
        ctx.stroke();
    } else {
        ctx.arc(10, y + 5, 4, 0.2 * Math.PI, 0.8 * Math.PI);
        ctx.stroke();
    }
}

/** Twig arms out of the middle potato: down, up in a cheer, or up as a shield. */
function drawArms(t, layer) {
    const cheer = stack.mood === "cheer";
    const shield = stack.mood === "flinch";
    const nervous = stack.mood === "nervous";
    for (const side of [-1, 1]) {
        // The arm on the far side goes behind the potato.
        if ((layer === "back") !== (side === 1)) continue;
        const shoulder = [side * (t.rx - 6), t.y - 2];
        let hand;
        if (cheer) hand = [side * 50, t.y - 46 + Math.sin(game.time * 12 + side) * 5];
        else if (shield) hand = [side * 14 - 6, HEAD_Y + 4];
        else if (nervous) hand = [side * 44, t.y - 6 + Math.sin(game.time * 40) * 2];
        else hand = [side * 50, t.y + 18];
        const elbow = [
            lerp(shoulder[0], hand[0], 0.5) + side * 4,
            lerp(shoulder[1], hand[1], 0.5) + (cheer ? 0 : 4),
        ];
        inkedLine(ctx, [shoulder, elbow, hand], "#8a5a33", 5, 2.5);
        // Two twiggy fingers.
        const a = Math.atan2(hand[1] - elbow[1], hand[0] - elbow[0]);
        for (const f of [-0.6, 0.6]) {
            inkedLine(
                ctx,
                [hand, [hand[0] + Math.cos(a + f) * 8, hand[1] + Math.sin(a + f) * 8]],
                "#8a5a33",
                3.5,
                2
            );
        }
    }
}

/** The top potato's face: it watches the potato, and has a feeling about it. */
function drawTopFace(t) {
    const hy = t.y;
    // Cheeks.
    ctx.fillStyle = "rgba(229, 72, 77, 0.28)";
    for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(side * 15, hy + 8, 5, 3, 0, 0, Math.PI * 2);
        ctx.fill();
    }
    // Eyes: they follow the potato, or the cannon.
    const target = potato ?? { x: PIVOT.x + 60, y: PIVOT.y - 40 };
    const lx = target.x - (stack.x + leanAt(hy));
    const ly = target.y - (hy + stack.hop);
    const len = Math.hypot(lx, ly) || 1;
    const px = (lx / len) * 2.6;
    const py = (ly / len) * 2.6;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    const brow =
        stack.mood === "nervous" || stack.mood === "flinch" ? -4 : stack.mood === "dizzy" ? 2 : 0;
    for (const side of [-1, 1]) {
        const ex = side * 9;
        const ey = hy - 2;
        ctx.beginPath();
        ctx.moveTo(ex - 5, ey - 9 + brow - (stack.mood === "nervous" ? side * -1.5 : 0));
        ctx.lineTo(ex + 5, ey - 9 + brow + (stack.mood === "nervous" ? side * -1.5 : 0));
        ctx.stroke();
        if (stack.mood === "dizzy") {
            ctx.beginPath();
            ctx.moveTo(ex - 4, ey - 4);
            ctx.lineTo(ex + 4, ey + 4);
            ctx.moveTo(ex + 4, ey - 4);
            ctx.lineTo(ex - 4, ey + 4);
            ctx.stroke();
        } else if (stack.mood === "flinch" || stack.blink > 0) {
            ctx.beginPath();
            if (stack.mood === "flinch") {
                ctx.moveTo(ex - 4 * side, ey - 3);
                ctx.lineTo(ex + 3 * side, ey);
                ctx.lineTo(ex - 4 * side, ey + 3);
            } else {
                ctx.moveTo(ex - 4, ey);
                ctx.lineTo(ex + 4, ey);
            }
            ctx.stroke();
        } else if (stack.mood === "cheer") {
            ctx.beginPath();
            ctx.arc(ex, ey + 2, 4, Math.PI * 1.1, Math.PI * 1.9);
            ctx.stroke();
        } else {
            const wide = stack.mood === "nervous" ? 5.6 : 4.6;
            circle(ctx, ex, ey, wide);
            inked(ctx, "#ffffff", 2);
            circle(ctx, ex + px, ey + py, 2.4);
            ctx.fillStyle = INK;
            ctx.fill();
        }
    }
    // Mouth.
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    if (stack.mood === "nervous") {
        ctx.moveTo(-7, hy + 11);
        for (let i = 1; i <= 4; i++) ctx.lineTo(-7 + i * 3.5, hy + 11 + (i % 2 ? -2 : 1));
        ctx.stroke();
    } else if (stack.mood === "flinch") {
        roundRect(ctx, -6, hy + 8, 12, 7, 3);
        inked(ctx, "#ffffff", 2);
    } else if (stack.mood === "cheer") {
        ctx.moveTo(-8, hy + 7);
        ctx.quadraticCurveTo(0, hy + 21, 8, hy + 7);
        ctx.closePath();
        inked(ctx, "#a33b3b", 2.5);
    } else if (stack.mood === "dizzy") {
        ctx.moveTo(-7, hy + 12);
        ctx.quadraticCurveTo(-3, hy + 7, 0, hy + 12);
        ctx.quadraticCurveTo(3, hy + 17, 7, hy + 12);
        ctx.stroke();
    } else {
        ctx.arc(0, hy + 6, 6, 0.2 * Math.PI, 0.8 * Math.PI);
        ctx.stroke();
    }
    // Sweat when nervous, stars when dizzy.
    if (stack.mood === "nervous" || stack.mood === "flinch") {
        const drip = (game.time * 26) % 14;
        const sx = t.rx + 2;
        ctx.beginPath();
        ctx.moveTo(sx, hy - 14 + drip);
        ctx.quadraticCurveTo(sx + 6, hy - 4 + drip, sx, hy - 2 + drip);
        ctx.quadraticCurveTo(sx - 6, hy - 4 + drip, sx, hy - 14 + drip);
        inked(ctx, "#9fd5f0", 2);
    }
    if (stack.mood === "dizzy") {
        for (let i = 0; i < 3; i++) {
            const a = game.time * 4 + (i / 3) * Math.PI * 2;
            star(Math.cos(a) * 36, hy - 32 + Math.sin(a) * 8, 7);
        }
    }
}

function drawBow(t) {
    ctx.save();
    ctx.translate(t.rx - 6, t.y - t.ry + 8);
    ctx.rotate(0.4);
    for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(side * 14, -10, side * 15, 0);
        ctx.quadraticCurveTo(side * 14, 10, 0, 0);
        inked(ctx, "#f4c56e", 2.5);
    }
    circle(ctx, 0, 0, 4);
    inked(ctx, "#f4c56e", 2.5);
    ctx.restore();
}

function drawSprout(t) {
    const y = t.y - t.ry + 2;
    ctx.lineCap = "round";
    inkedLine(
        ctx,
        [
            [0, y + 2],
            [1, y - 8],
        ],
        "#5aa35a",
        4,
        2
    );
    for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(1, y - 7);
        ctx.quadraticCurveTo(1 + side * 6, y - 18, 1 + side * 14, y - 12);
        ctx.quadraticCurveTo(1 + side * 8, y - 4, 1, y - 7);
        inked(ctx, "#7cc36a", 2);
    }
}

function drawBeanie(t, look) {
    const y = t.y - t.ry + 12;
    ctx.beginPath();
    ctx.moveTo(-t.rx + 2, y);
    ctx.bezierCurveTo(-t.rx + 2, y - 30, t.rx - 2, y - 30, t.rx - 2, y);
    ctx.closePath();
    inked(ctx, look.beanie, 3);
    roundRect(ctx, -t.rx, y - 5, t.rx * 2, 10, 4);
    inked(ctx, look.beanie, 3);
    ctx.strokeStyle = "rgba(0, 0, 0, 0.18)";
    ctx.lineWidth = 2;
    for (let i = -3; i <= 3; i++) {
        ctx.beginPath();
        ctx.moveTo(i * 7, y - 5);
        ctx.lineTo(i * 7, y + 5);
        ctx.stroke();
    }
    circle(ctx, 0, y - 26, 6);
    inked(ctx, "#f2f2ef", 2.5);
}

/** Fireflies over the hedge at night. */
function drawFireflies(night) {
    const left = cam.x - size.w / 2 / cam.zoom;
    for (let i = 0; i < 14; i++) {
        const r = seeded(i * 131 + 7);
        const span = size.w / cam.zoom;
        const x = left + ((r() * span + game.time * (8 + r() * 10)) % span);
        const y = -30 - r() * 120 + Math.sin(game.time * (1 + r()) + i) * 14;
        const glow = (Math.sin(game.time * (2 + r() * 2) + i * 2) + 1) / 2;
        ctx.globalAlpha = night * glow;
        circle(ctx, x, y, 7);
        ctx.fillStyle = "rgba(255, 236, 140, 0.35)";
        ctx.fill();
        circle(ctx, x, y, 2.4);
        ctx.fillStyle = "#fff3a6";
        ctx.fill();
    }
    ctx.globalAlpha = 1;
}

function star(x, y, r) {
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
        const rr = i % 2 ? r * 0.45 : r;
        ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    ctx.closePath();
    inked(ctx, "#f4c56e", 2);
}

function drawBug() {
    const sev = SEVERITY[bug.sev];
    ctx.save();
    ctx.translate(bug.x, bug.y);
    ctx.rotate(bug.rot);
    // Every bug is drawn at the minor's size and scaled to its own.
    ctx.scale(sev.r / BUG_R, sev.r / BUG_R);
    const t = game.time;
    const legs = bug.on ? Math.sin(t * 22) * 2.4 : Math.sin(t * 40) * 3;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    for (const side of [-1, 1]) {
        for (let i = 0; i < 3; i++) {
            const phase = i % 2 ? legs : -legs;
            ctx.beginPath();
            ctx.moveTo(side * 7, -2 + i * 4);
            ctx.lineTo(side * 14, 2 + i * 4 + phase * 0.5);
            ctx.lineTo(side * 17, 6 + i * 4 + phase);
            ctx.stroke();
        }
        ctx.beginPath();
        ctx.moveTo(side * 3, -11);
        ctx.quadraticCurveTo(side * 7, -21, side * 12 + Math.sin(t * 6 + side) * 1.5, -22);
        ctx.stroke();
        circle(ctx, side * 12 + Math.sin(t * 6 + side) * 1.5, -22, 2.6);
        inked(ctx, sev.body, 1.8);
    }
    circle(ctx, 0, -9, 7);
    inked(ctx, "#2a2d33", 2.2);
    ctx.beginPath();
    ctx.ellipse(0, 3, BUG_R, BUG_R * 0.85, 0, 0, Math.PI * 2);
    inked(ctx, sev.body, 2.5);
    ctx.beginPath();
    ctx.moveTo(0, -8);
    ctx.lineTo(0, 15);
    ctx.stroke();
    ctx.fillStyle = INK;
    for (const [sx, sy, r] of [
        [-6, -1, 2.4],
        [6, 1, 2.4],
        [-5, 8, 2],
        [5, 9, 1.8],
    ]) {
        circle(ctx, sx, sy, r);
        ctx.fill();
    }
    ctx.fillStyle = "rgba(255, 255, 255, 0.55)";
    ctx.beginPath();
    ctx.ellipse(-6, -3, 3.5, 2, -0.6, 0, Math.PI * 2);
    ctx.fill();
    // Eyes that watch the potato.
    const target = potato ?? { x: 0, y: -1000 };
    const lx = target.x - bug.x;
    const ly = target.y - bug.y;
    const len = Math.hypot(lx, ly) || 1;
    for (const ex of [-3, 3]) {
        circle(ctx, ex, -11, 2.8);
        ctx.fillStyle = "#ffffff";
        ctx.fill();
        circle(ctx, ex + (lx / len) * 1.2, -11 + (ly / len) * 1.2, 1.3);
        ctx.fillStyle = INK;
        ctx.fill();
    }
    if (bug.sev === "blocker" && bug.on) {
        // A siren, flashing red and blue.
        const red = Math.sin(game.time * 14) > 0;
        roundRect(ctx, -4, -21, 8, 7, 3);
        inked(ctx, red ? "#ff5a5f" : "#5b8cff", 1.6);
        ctx.globalAlpha = 0.3;
        circle(ctx, 0, -18, 12 + Math.sin(game.time * 14) * 2);
        ctx.fillStyle = red ? "#ff5a5f" : "#5b8cff";
        ctx.fill();
        ctx.globalAlpha = 1;
    }
    ctx.restore();
    if (bug.on && !(bug.tauntTimer > 0)) drawSeverity(sev);
}

/** The bug's severity, as a chip beside it, the way Notato labels a note. */
function drawSeverity(sev) {
    ctx.font = "700 12px 'JetBrains Mono', monospace";
    const w = ctx.measureText(bug.sev).width + 26;
    const x = bug.x + sev.r + 10;
    const y = bug.y - sev.r - 4;
    roundRect(ctx, x, y - 11, w, 22, 11);
    inked(ctx, "#ffffff", 2);
    circle(ctx, x + 11, y, 4);
    ctx.fillStyle = sev.chip;
    ctx.fill();
    ctx.fillStyle = INK;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(bug.sev, x + 19, y + 1);
}

/** The current annoyance, popping in when it is new and wobbling when hit. */
function drawPest() {
    const { w, h } = pest;
    const pop = reduceMotion.matches ? 1 : easeBack(pest.appear);
    if (pop <= 0) return;
    ctx.save();
    ctx.translate(pest.x + w / 2, pest.y + h / 2);
    ctx.rotate(pest.wobble * 0.08);
    ctx.scale(pop, pop);
    if (pest.kind === "spinner") drawSpinner(w / 2);
    else {
        ctx.fillStyle = "rgba(35, 38, 43, 0.18)";
        roundRect(ctx, -w / 2 + 4, -h / 2 + 7, w, h, 12);
        ctx.fill();
        roundRect(ctx, -w / 2, -h / 2, w, h, 12);
        inked(ctx, "#fffaf0", 3);
        if (pest.kind === "cookies") drawCookieBanner(w);
        else if (pest.kind === "chat") drawChat(w, h);
        else drawNewsletter(w, h);
    }
    ctx.restore();
}

function drawCookieBanner(w) {
    // The cookie, with a bite out of it.
    const cx = -w / 2 + 24;
    ctx.save();
    ctx.translate(cx, 0);
    const R = 12;
    const r = 6;
    const bx = 9;
    const by = -8;
    const d = Math.hypot(bx, by);
    const at = Math.atan2(by, bx);
    const half = Math.acos((R * R + d * d - r * r) / (2 * R * d));
    const from = at + half;
    const to = at - half + Math.PI * 2;
    ctx.beginPath();
    ctx.arc(0, 0, R, from, to);
    ctx.arc(
        bx,
        by,
        r,
        Math.atan2(Math.sin(to) * R - by, Math.cos(to) * R - bx),
        Math.atan2(Math.sin(from) * R - by, Math.cos(from) * R - bx),
        true
    );
    ctx.closePath();
    ctx.translate(-cx, 0);
    inked(ctx, "#d9a05a", 2.5);
    ctx.fillStyle = "#5b3a1e";
    for (const [dx, dy] of [
        [-4, -4],
        [3, 3],
        [-5, 5],
        [5, -2],
    ]) {
        circle(ctx, cx + dx, dy, 1.8);
        ctx.fill();
    }
    ctx.restore();
    ctx.fillStyle = INK;
    ctx.font = "700 14px Figtree, system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText("We use cookies", -w / 2 + 44, -7);
    // Two buttons nobody wants to press.
    ctx.font = "700 10px Figtree, system-ui, sans-serif";
    ctx.textAlign = "center";
    roundRect(ctx, -w / 2 + 44, 4, 54, 15, 7.5);
    inked(ctx, "#1f8a78", 1.8);
    ctx.fillStyle = "#ffffff";
    ctx.fillText("Accept all", -w / 2 + 71, 12);
    roundRect(ctx, -w / 2 + 104, 4, 52, 15, 7.5);
    inked(ctx, "#fffaf0", 1.8);
    ctx.fillStyle = INK;
    ctx.fillText("Settings", -w / 2 + 130, 12);
}

/** A support chat that opened itself: a greeting, someone typing, and the launcher with an unread badge. */
function drawChat(w, h) {
    // The avatar, smiling far too much.
    const ax = -w / 2 + 24;
    circle(ctx, ax, 0, 14);
    inked(ctx, "#8b5cf6", 2.5);
    ctx.fillStyle = INK;
    circle(ctx, ax - 4.5, -3, 1.8);
    ctx.fill();
    circle(ctx, ax + 4.5, -3, 1.8);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(ax, 1, 6, 0.2, Math.PI - 0.2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.fillStyle = INK;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.font = "700 14px Figtree, system-ui, sans-serif";
    ctx.fillText("Hi there! 👋", -w / 2 + 46, -9);
    ctx.font = "600 11px Figtree, system-ui, sans-serif";
    ctx.fillStyle = "#5c636b";
    ctx.fillText("Need any help?", -w / 2 + 46, 8);
    // Typing…
    for (let i = 0; i < 3; i++) {
        const lift = Math.max(0, Math.sin(game.time * 7 - i * 0.9)) * 3;
        circle(ctx, w / 2 - 30 + i * 8, 9 - lift, 2.4);
        ctx.fillStyle = "#9aa1a9";
        ctx.fill();
    }
    // The unread badge.
    circle(ctx, w / 2 - 4, -h / 2 + 3, 9);
    inked(ctx, "#e5484d", 2);
    ctx.fillStyle = "#ffffff";
    ctx.font = "800 11px Figtree, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("1", w / 2 - 4, -h / 2 + 4);
}

/** A newsletter pop-up, discount and all, with a close button nobody can find. */
function drawNewsletter(w, h) {
    ctx.fillStyle = INK;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.font = "800 15px Figtree, system-ui, sans-serif";
    ctx.fillText("Get 10% off!", -w / 2 + 14, -h / 2 + 20);
    ctx.font = "600 10px Figtree, system-ui, sans-serif";
    ctx.fillStyle = "#5c636b";
    ctx.fillText("Join our newsletter", -w / 2 + 14, -h / 2 + 37);
    roundRect(ctx, -w / 2 + 14, -4, w - 28, 18, 5);
    inked(ctx, "#ffffff", 1.6);
    ctx.fillStyle = "#9aa1a9";
    ctx.fillText("you@example.com", -w / 2 + 21, 5.5);
    roundRect(ctx, -w / 2 + 14, 20, w - 28, 19, 9.5);
    inked(ctx, "#ec4899", 1.8);
    ctx.fillStyle = "#ffffff";
    ctx.font = "800 11px Figtree, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Subscribe", 0, 30);
    // The close button, tiny.
    ctx.strokeStyle = "#9aa1a9";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(w / 2 - 15, -h / 2 + 9);
    ctx.lineTo(w / 2 - 9, -h / 2 + 15);
    ctx.moveTo(w / 2 - 9, -h / 2 + 9);
    ctx.lineTo(w / 2 - 15, -h / 2 + 15);
    ctx.stroke();
}

/** A loading spinner that will never finish. */
function drawSpinner(r) {
    ctx.fillStyle = "rgba(35, 38, 43, 0.18)";
    circle(ctx, 4, 7, r);
    ctx.fill();
    circle(ctx, 0, 0, r);
    inked(ctx, "#fffaf0", 3);
    ctx.lineCap = "round";
    ctx.lineWidth = 7;
    ctx.strokeStyle = "#e3e5e8";
    circle(ctx, 0, 0, r - 12);
    ctx.stroke();
    const spin = game.time * 5.5;
    const arc = 1.4 + Math.sin(game.time * 2.2) * 0.9;
    ctx.strokeStyle = "#1f8a78";
    ctx.beginPath();
    ctx.arc(0, 0, r - 12, spin, spin + arc);
    ctx.stroke();
    ctx.fillStyle = INK;
    ctx.font = "700 11px Figtree, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const dots = ".".repeat(1 + (Math.floor(game.time * 2.5) % 3));
    ctx.fillText(`Loading${dots}`, 0, r + 14);
}

function drawRing(r) {
    const t = 1 - r.life / r.max;
    if (r.flash) {
        ctx.save();
        ctx.translate(r.x, r.y);
        ctx.rotate(-r.angle);
        drawBurst(ctx, 14, 0, 30 * (1 - t * 0.5), "#ffd84d", 8, 0.3);
        ctx.restore();
        return;
    }
    circle(ctx, r.x, r.y, r.r + t * 70);
    ctx.lineWidth = 6 * (1 - t);
    ctx.strokeStyle = `rgba(255, 255, 255, ${1 - t})`;
    ctx.stroke();
}

function drawFloater(f) {
    const age = f.max - f.life;
    const pop = easeBack(clamp(age / 0.35, 0, 1));
    const alpha = clamp(f.life / 0.35, 0, 1);
    ctx.save();
    ctx.globalAlpha = alpha;
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
    } else if (f.kind === "burst") {
        ctx.rotate(-0.12);
        drawBurst(ctx, 0, 0, 46, "#ffd84d", 11, 0.4);
        inkedText(ctx, f.text, 0, 1, "#e5484d", 22, 800, 5);
    } else {
        inkedText(ctx, f.text, 0, 0, f.color ?? "#ffffff", 20, 800, 5);
    }
    ctx.restore();
}

function bubble(text, x, y, tailX, size = 17, italic = true) {
    ctx.font = `${italic ? "italic " : ""}600 ${size}px Figtree, system-ui, sans-serif`;
    const w = ctx.measureText(text).width + 26;
    const h = size + 18;
    const left = x - w / 2;
    ctx.beginPath();
    ctx.roundRect(left, y - h / 2, w, h, h / 2);
    ctx.moveTo(tailX - 7, y + h / 2 - 1);
    ctx.lineTo(tailX + 2, y + h / 2 + 12);
    ctx.lineTo(tailX + 9, y + h / 2 - 1);
    inked(ctx, "#ffffff", 2.5);
    // Cover the seam between the tail and the bubble.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(tailX - 5, y + h / 2 - 4, 13, 5);
    ctx.fillStyle = INK;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x, y + 1);
}

function drawSpeech() {
    ctx.globalAlpha = clamp(stack.speechTimer * 4, 0, 1);
    const y = HEAD_Y + stack.hop - HEAD_R - 78;
    ctx.font = "italic 600 17px Figtree, system-ui, sans-serif";
    const half = ctx.measureText(stack.speech).width / 2 + 13;
    bubble(stack.speech, stack.x - Math.max(half - 26, 40), y, stack.x - 16);
    ctx.globalAlpha = 1;
}

function drawTaunt() {
    ctx.globalAlpha = clamp(bug.tauntTimer * 4, 0, 1);
    bubble(bug.taunt, bug.x + 46, bug.y - 26, bug.x + 14, 13, false);
    ctx.globalAlpha = 1;
}

function drawStreaks() {
    ctx.lineCap = "round";
    ctx.lineWidth = 2;
    for (const s of streaks) {
        const a = clamp(s.life / s.max, 0, 1) * 0.55;
        ctx.strokeStyle = `rgba(255, 255, 255, ${a})`;
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(s.x - Math.sign(s.vx) * s.len, s.y);
        ctx.stroke();
    }
}

function drawOffscreen() {
    const x = clamp(toScreenX(potato.x), 16, size.w - 16);
    ctx.beginPath();
    ctx.moveTo(x, 8);
    ctx.lineTo(x - 9, 24);
    ctx.lineTo(x + 9, 24);
    ctx.closePath();
    inked(ctx, "#f4c56e", 2.5);
}

function drawPull() {
    ctx.setLineDash([6, 7]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(35, 38, 43, 0.45)";
    ctx.beginPath();
    ctx.moveTo(aim.from.x, aim.from.y);
    ctx.lineTo(aim.to.x, aim.to.y);
    ctx.stroke();
    ctx.setLineDash([]);
    circle(ctx, aim.from.x, aim.from.y, 9);
    ctx.fillStyle = "rgba(35, 38, 43, 0.18)";
    ctx.fill();
    circle(ctx, aim.to.x, aim.to.y, 11);
    inked(ctx, "#45bfa8", 2.5);
}

function drawAimReadout() {
    const x = toScreenX(PIVOT.x + 30);
    const y = toScreenY(PIVOT.y - 120);
    const text = `${Math.round((aim.angle * 180) / Math.PI)}°  ·  ${Math.round(aim.power * 100)}%`;
    ctx.font = "600 12px 'JetBrains Mono', monospace";
    const w = ctx.measureText(text).width + 18;
    roundRect(ctx, x - w / 2, y - 12, w, 24, 8);
    ctx.fillStyle = "rgba(23, 24, 27, 0.8)";
    ctx.fill();
    ctx.fillStyle = "#eceded";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x, y + 1);
}

function drawBanner() {
    const t = game.banner;
    const enter = easeBack(clamp(t / 0.45, 0, 1));
    const leave = clamp((t - 2.1) / 0.4, 0, 1);
    const y = size.h * 0.24 - (1 - enter) * 40 - leave * 30;
    ctx.save();
    ctx.globalAlpha = Math.min(1, t * 4) * (1 - leave);
    const big = clamp(size.w * 0.075, 30, 56);
    ctx.translate(size.w / 2, y);
    ctx.rotate(-0.03);
    inkedText(ctx, `Bug ${game.level}`, 0, 0, "#ffffff", big, 800, Math.max(5, big * 0.14));
    const sub = `${bug.sev}  ·  ${Math.round(stack.base / METRE)} m  ·  wind ${windLabel()}`;
    ctx.font = "700 14px 'JetBrains Mono', monospace";
    const w = ctx.measureText(sub).width + 24;
    roundRect(ctx, -w / 2, big * 0.62, w, 28, 14);
    inked(ctx, "#17181b", 2.5);
    ctx.fillStyle = "#eceded";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(sub, 0, big * 0.62 + 15);
    ctx.restore();
}

// -------------------------------------------------------------------- go

setUpLevel(1);
stack.x = stack.base;
snapCamera();
updateHud();
let started = false;
const debug = { paused: false };
loop((dt) => {
    if (debug.paused) return;
    if (!started) {
        // Before the first game, the scene idles behind the title card.
        game.time += dt;
        stepStack(dt);
        stepBug(dt);
        stepCamera(dt);
    } else step(dt);
    draw();
});
// A resize clears the canvas, so draw again at once rather than at the next frame.
onResize(() => {
    if (!started) snapCamera();
    draw();
});

// For checking the game by hand: ?debug puts its state on window, with a way to run it without frames.
if (new URLSearchParams(location.search).has("debug"))
    window.spudCannon = {
        game,
        aim,
        stack,
        bug,
        pest,
        cam,
        fire,
        debug,
        tick(seconds) {
            for (let t = 0; t < seconds; t += 1 / 60) step(1 / 60);
            draw();
        },
    };

showCard(stage, {
    kicker: "A Notato game",
    title: "Spud Cannon",
    image: "../notato.png",
    text: "Russ the potato has a bug on top. Knock it off with a potato. Do not hit Russ.",
    button: "Fire away",
}).then(() => {
    started = true;
    newGame();
});
