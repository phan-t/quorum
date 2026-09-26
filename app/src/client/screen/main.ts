/**
 * The big screen. Served at `/screen`, token in the fragment.
 *
 * A 1920 × 1080 tab, shared into a video call, seen as maybe an 800px tile
 * after two rounds of compression. The whole design is about surviving that:
 * light type on dark (codecs subsample chroma, so colour edges blur and
 * luminance edges survive), colour only as fills, a 5% safe margin, few words,
 * and nothing that glides — video compression turns a smooth slide into a
 * smear, so things appear, hold, and cut.
 *
 * Read-only. Nothing here takes input; the host drives it from the console.
 */

import type {
  ActivitySummary,
  ArcadeView,
  RenderState,
  StandingRow,
  TriviaView,
} from "../../protocol.ts";
import { h, qs, replace, setAttr, setClass, setText } from "../shared/dom.ts";
import { QuorumClient } from "../shared/net.ts";
import { mockBadge, mockTransport, readMockConfig } from "../shared/mock.ts";
import {
  ARCADE_ROUND_CARD,
  HOW_TO_PLAY,
  ARCADE_ROUND_LABEL,
  HOUSE,
  FINAL_DWELL_MS,
  LIGHT_FACE,
  SEALED_LINE,
  STAFF_CARD,
  STATE_LOCK_ERROR,
  UNSEAL_FACE,
  activityHue,
  answerTiles,
  bridgeSteps,
  finalRevealMs,
  formatCountdown,
  gridEntries,
  playerName,
  playerTag,
  questionLabel,
  remainingMs,
  resolveView,
  stackedBar,
  timerFraction,
  tugBeatAt,
  tugRope,
  unsealRevealHead,
  waveRosters,
  wipeFraction,
  type ViewKind,
} from "../shared/view.ts";
import { drawQr, encodeQr } from "../shared/qr.ts";
import { lockGlyph } from "../participant/view.ts";

document.title = "Quorum";

const mock = readMockConfig();
const app = qs<HTMLElement>("#app");

function readToken(): string {
  const raw = location.hash.replace(/^#/, "");
  if (raw === "") return "";
  if (raw.includes("=")) return new URLSearchParams(raw).get("token") ?? "";
  return raw;
}

const screenToken = readToken() || (mock ? "mock-screen-token" : "");

/**
 * The join URL, from the join code the server sends this screen in
 * `RenderState`. `?join=` still wins, so a screen can be pointed at a short
 * vanity link or a projector-friendly host name.
 *
 * There is deliberately no format check on the code: it used to be tested
 * against `[A-Z]{2,8}`, which stopped matching the day join codes became
 * Vault-shaped `hvs.` tokens and silently left the QR off the wall.
 */
function joinUrl(joinCode: string | undefined): string | null {
  const explicit = new URLSearchParams(location.search).get("join");
  if (explicit) return explicit;
  const code = (joinCode ?? "").trim();
  if (code === "") return null;
  return `${location.origin}/j/${encodeURIComponent(code)}`;
}

if (screenToken === "") {
  replace(app, [
    h("section", { class: "s-stage s-gate" }, [
      h("p", { class: "s-kicker label", text: "Quorum" }),
      h("h1", { class: "display s-title", text: "This screen needs its token" }),
      h("p", { class: "s-line", text: "Open it as /screen#<screen token>." }),
    ]),
  ]);
  throw new Error("no screen token");
}

/* ------------------------------------------------------------------ */

const banner = h("div", {
  class: "s-banner",
  attrs: { hidden: true, role: "status" },
});
const stage = h("div", { class: "s-root" });
const toastBar = h("div", { class: "s-toast", attrs: { hidden: true } });
/**
 * Practice, said to the whole room at once.
 *
 * This is the surface everyone is looking at, so it is the surface that has to
 * carry it. A round that turns out afterwards not to have counted is a worse
 * outcome than a round nobody took seriously.
 */
const practiceBar = h("div", {
  class: "s-practice",
  attrs: { hidden: true, role: "status" },
  text: "PRACTICE — nothing is being scored",
});
replace(app, [banner, practiceBar, stage, toastBar]);
if (mock) document.body.appendChild(mockBadge());

interface Scene {
  node: HTMLElement;
  update(state: RenderState): void;
  stop?(): void;
}

let kind: ViewKind | null = null;
let scene: Scene | null = null;
let client: QuorumClient | null = null;

/** Corrected server time. Every countdown on this surface is drawn off it. */
const serverNow = (): number => client?.now() ?? Date.now();

function render(state: RenderState): void {
  practiceBar.hidden = !state.practice;
  const next = resolveView(state);
  if (next !== kind) {
    scene?.stop?.();
    kind = next;
    scene = build(next);
    replace(stage, [scene.node]);
    stage.dataset["view"] = next;
  }
  scene?.update(state);
}

function build(k: ViewKind): Scene {
  switch (k) {
    case "lobby":
      return sceneLobby();
    case "holding":
      return sceneHolding();
    case "standings":
      return sceneStandings();
    case "sealed":
      return sceneSealed();
    case "final":
      return sceneFinal();
    case "waiting":
      return sceneCard("Quorum", "Not open yet.");
    case "sendoff":
      return sceneSendoff();
    case "trivia":
      return sceneTrivia();
    case "arcade":
      return sceneArcade();
  }
}

/* ------------------------------------------------------------------ */
/* Scenes                                                              */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* The send-off                                                        */
/* ------------------------------------------------------------------ */

/**
 * A photo or the music track, as a URL on this origin.
 *
 * The send-off file carries filenames — keys — and the bytes live in the
 * session's own asset rows, served over HTTP the way the promo card is. A
 * `data:` key is passed through untouched: that is how the mock stands in for
 * an endpoint, and it is the only other shape allowed here. An `http:` key
 * would make a send-off file able to point the screen everybody is watching
 * at somebody else's server, which is not a thing a list of filenames should
 * be able to do.
 */
function assetUrl(sid: string, key: string): string {
  if (key.startsWith("data:")) return key;
  return `/api/sessions/${encodeURIComponent(sid)}/assets/${encodeURIComponent(key)}`;
}

/**
 * Alternative text for a photo, out of its filename.
 *
 * It is all there is: the file carries keys and no captions, and a montage of
 * images with no description at all is nothing whatsoever to a screen reader
 * at the one moment in the session that is entirely about a person. A
 * filename is what somebody called the photo, so `the-whiteboard.jpg` reads
 * as "Photo: the whiteboard", which is worse than a caption and much better
 * than silence.
 */
function photoAlt(key: string): string {
  // A `data:` key is the mock's, and there is no filename in it to read.
  if (key.startsWith("data:")) return "Photo";
  const stem = (key.split("/").pop() ?? key).replace(/\.[a-z0-9]+$/i, "");
  const words = stem.replace(/[-_]+/g, " ").trim();
  return words === "" ? "Photo" : `Photo: ${words}`;
}

/* ---- music ---------------------------------------------------------- */

/**
 * Audio, armed by the first gesture this tab receives.
 *
 * A browser will not start audio without a user gesture, and the gesture has
 * to happen *in this tab*: the host pressing play on the console is a gesture
 * in a different document and buys this one nothing. So the Desktop arms on
 * the first click or key it gets — which the host makes anyway when they open
 * it and put it on the screen share — and the preflight row in the runbook is
 * what proves it armed, because nothing on screen can.
 *
 * If it never arms, every call below is a no-op and the montage runs silent.
 * That is the required failure: `play()` rejecting is not an error worth
 * throwing on the surface the whole room is looking at.
 */
let audioArmed = false;
let armWaiting: (() => void) | null = null;

function armAudio(): void {
  if (audioArmed) return;
  audioArmed = true;
  const waiting = armWaiting;
  armWaiting = null;
  waiting?.();
}

addEventListener("pointerdown", armAudio, { passive: true });
addEventListener("click", armAudio, { passive: true });
addEventListener("keydown", armAudio, { passive: true });

const MUSIC_VOLUME = 0.55;
const MUSIC_FADE_MS = 1_600;

let musicEl: HTMLAudioElement | null = null;
let musicKey: string | null = null;
let musicRamp: ReturnType<typeof setInterval> | null = null;

function rampVolume(el: HTMLAudioElement, to: number, ms: number, done?: () => void): void {
  if (musicRamp !== null) clearInterval(musicRamp);
  const from = el.volume;
  const started = Date.now();
  const STEP_MS = 50;
  musicRamp = setInterval(() => {
    const t = Math.min(1, (Date.now() - started) / ms);
    // Clamped: a volume outside 0..1 throws, and a fade is not worth an
    // exception on this surface.
    el.volume = Math.max(0, Math.min(1, from + (to - from) * t));
    if (t < 1) return;
    if (musicRamp !== null) clearInterval(musicRamp);
    musicRamp = null;
    done?.();
  }, STEP_MS);
}

/** Start the montage's track, or wait for the gesture that allows it. */
function startMusic(url: string, key: string): void {
  if (musicKey === key) return;
  stopMusic();
  const el = new Audio(url);
  el.loop = true;
  el.volume = 0;
  musicEl = el;
  musicKey = key;
  const begin = (): void => {
    // A newer frame may have moved on while we waited for the gesture.
    if (musicEl !== el) return;
    void el
      .play()
      .then(() => {
        if (musicEl === el) rampVolume(el, MUSIC_VOLUME, MUSIC_FADE_MS);
      })
      // Autoplay refused, the file missing, the endpoint not there yet: the
      // send-off runs without music and says nothing about it.
      .catch(() => {});
  };
  if (audioArmed) begin();
  else armWaiting = begin;
}

/**
 * Fade out and stop — which is what happens when the montage ends.
 *
 * The messages are read aloud over silence. Music under somebody reading is
 * the failure the note spends three paragraphs on, so the track goes before
 * the first kudo rather than under it.
 */
function fadeOutMusic(): void {
  const el = musicEl;
  if (el === null) return;
  musicEl = null;
  musicKey = null;
  armWaiting = null;
  rampVolume(el, 0, MUSIC_FADE_MS, () => {
    el.pause();
  });
}

/** Cut it. For leaving the segment, where a fade would outlive the scene. */
function stopMusic(): void {
  if (musicRamp !== null) clearInterval(musicRamp);
  musicRamp = null;
  armWaiting = null;
  const el = musicEl;
  musicEl = null;
  musicKey = null;
  if (el === null) return;
  el.pause();
  el.removeAttribute("src");
}

/* ---- the scene ------------------------------------------------------ */

/** The range the message is fitted within — see `fitMessage`. */
const KUDO_MIN_PX = 24;
/* Raised from 112 with the split. The ceiling used to be unreachable — the
   longest message forced every message down near 39px — and now that no slide
   runs past 260 characters the fit can actually arrive at the top of the
   range, which is the size increase. */
const KUDO_MAX_PX = 168;

/** The shortest a photo may hold, however many there are. */
const PHOTO_MIN_MS = 2_500;
/** The closing photos have no `seconds` of their own; they hold this long. */
const PHOTO_CLOSING_MS = 6_000;

interface MontagePhoto {
  readonly key: string;
  readonly url: string;
  readonly alt: string;
  /** null while it is still loading. */
  ok: boolean | null;
}

/**
 * The send-off.
 *
 * Four frames, and the host walks between them: a montage with music, the
 * messages one at a time, the closing photos and line, and a resting frame
 * that is not a blank one.
 *
 * **The montage degrades to the title card.** Every photo is preloaded and
 * only joins the rotation once it has decoded, so a key whose asset row is
 * not there yet — the endpoint is being built as this is written — leaves the
 * name and the date on the screen rather than a broken-image glyph in front
 * of the room. All of them missing is the send-off the note describes as
 * still being the thing: a list of messages.
 *
 * **The type fits the message rather than stepping through bands.** The real
 * kudos run 34 to 145 words, and three bands mean a 219-character message and
 * a 221-character one are visibly different sizes for no reason anybody can
 * see. The size falls off as the square root of the length, which is what
 * keeps the *area* the text covers roughly constant — so every message fills
 * the screen and none of them overflows it. Clamped at both ends: 32px is
 * DESIGN.md's floor for a 1080p tab seen as an 800px tile.
 */
function sceneSendoff(): Scene {
  const photoA = h("img", { class: "s-photo", attrs: { alt: "", decoding: "async" } });
  const photoB = h("img", { class: "s-photo", attrs: { alt: "", decoding: "async" } });
  const montage = h("div", { class: "s-montage", attrs: { hidden: true } }, [
    photoA,
    photoB,
  ]);
  const kicker = h("p", { class: "s-kicker label" });
  // The date is not part of the name, so it does not share the name's line.
  const kickerSub = h("p", { class: "s-kicker-sub label", attrs: { hidden: true } });
  const message = h("p", { class: "s-kudo" });
  const from = h("p", { class: "s-kudo-from" });
  const counter = h("p", { class: "mono s-kudo-count" });
  const farewellName = h("p", { class: "s-farewell-name", attrs: { hidden: true } });
  // The message sits inside a box rather than being the box. The fit needs
  // something with a fixed height to measure against — a paragraph that
  // shrink-wraps always "fits", and the search would run to the top of the
  // range and overflow — and the words need to be centred *within* that
  // height rather than hanging from its top edge. One element cannot be both.
  const messageBox = h("div", { class: "s-kudo-box" }, [message]);
  const card = h("div", { class: "s-sendoff-card" }, [
    kicker,
    farewellName,
    kickerSub,
    messageBox,
    from,
    counter,
  ]);
  const node = h("section", { class: "s-stage s-sendoff" }, [montage, card]);

  /** The longest message in the set, so every message is set at one size. */
  let longestChars = 0;
  let photos: MontagePhoto[] = [];
  let shown = -1;
  let front = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** What the running montage is for, so a photo that decodes late can join. */
  let runPhase = "";
  let runSeconds = 0;
  /** Phase and photo list, so a broadcast does not restart the montage. */
  let signature = "";
  /** A run key named before it had decoded, shown the moment it does. */
  let pending: string | null = null;

  const layers = [photoA, photoB];

  function clearTimer(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function dwellMs(phase: string, seconds: number, count: number): number {
    if (phase === "closing") return PHOTO_CLOSING_MS;
    const total = seconds > 0 ? seconds * 1_000 : PHOTO_CLOSING_MS * count;
    return Math.max(PHOTO_MIN_MS, Math.round(total / Math.max(1, count)));
  }

  /** The next photo that actually loaded, after `from`. Null when none has. */
  function nextLoaded(after: number): number | null {
    for (let i = 1; i <= photos.length; i += 1) {
      const at = (after + i) % photos.length;
      if (photos[at]?.ok === true) return at;
    }
    return null;
  }

  /**
   * Queue the next photo.
   *
   * Called after every swap *and* whenever another photo finishes decoding,
   * which is the case that matters: the first photo to arrive is shown alone
   * and there is nothing to cross-fade to yet, so without the second call a
   * montage whose photos land a few milliseconds apart would stop on the
   * first one and stay there for the whole opening.
   */
  function schedule(): void {
    clearTimer();
    const ready = photos.filter((p) => p.ok === true).length;
    if (ready < 2 || shown === -1) return;
    timer = setTimeout(() => {
      timer = null;
      const following = nextLoaded(shown);
      if (following !== null) show(following);
    }, dwellMs(runPhase, runSeconds, ready));
  }

  function show(at: number): void {
    const photo = photos[at];
    if (photo === undefined) return;
    const next = layers[1 - front];
    if (next === undefined) return;
    next.src = photo.url;
    next.alt = photo.alt;
    // Two layers, one on top of the other: the incoming one fades up over the
    // outgoing one, so there is never a gap with nothing in it. Under
    // `prefers-reduced-motion` the stylesheet drops the transition and this
    // same swap is a cut.
    layers[front]?.classList.remove("is-on");
    next.classList.add("is-on");
    front = 1 - front;
    shown = at;
    montage.hidden = false;
    // The closing montage times itself; the run is advanced by the server, so
    // there is nothing local to queue.
    if (runPhase !== "run") schedule();
  }

  /**
   * Show one photograph, by key, from the set already preloaded.
   *
   * The run's cadence is the server's — every surface swaps on the same
   * broadcast — so this is the montage's cross-fade without its clock. A key
   * that has not decoded, or never will, leaves the previous photograph up:
   * the room sees a slightly longer beat rather than a broken-image glyph.
   */
  function showKey(key: string): void {
    const at = photos.findIndex((p) => p.key === key);
    if (at === -1) return;
    if (photos[at]?.ok !== true) {
      // Not yet decoded. `startMontage`'s probe calls back into here when it
      // lands, so a photo that is merely slow still arrives.
      pending = key;
      return;
    }
    pending = null;
    if (at === shown) return;
    show(at);
  }

  function startMontage(sid: string, keys: readonly string[], phase: string, seconds: number): void {
    clearTimer();
    shown = -1;
    front = 0;
    runPhase = phase;
    runSeconds = seconds;
    for (const layer of layers) {
      layer.classList.remove("is-on");
      layer.removeAttribute("src");
      layer.alt = "";
    }
    photos = keys.map((key) => ({
      key,
      url: assetUrl(sid, key),
      alt: photoAlt(key),
      ok: null,
    }));
    montage.hidden = true;
    if (photos.length === 0) return;
    for (const photo of photos) {
      // Preloaded rather than pointed at: an `<img>` given a 404 draws the
      // browser's broken-image glyph, and this is the surface where that
      // would happen in front of everybody. Only what decodes is ever shown.
      const probe = new Image();
      probe.onload = () => {
        photo.ok = true;
        // A photo that belongs to a montage this scene has since left is a
        // photo with nowhere to go.
        if (!photos.includes(photo)) return;
        if (pending !== null) {
          // The run is waiting on exactly this one.
          if (pending === photo.key) showKey(pending);
        } else if (runPhase === "run") {
          // Nothing waiting: the run shows what the server last named.
        } else if (shown === -1) {
          const first = nextLoaded(-1);
          if (first !== null) show(first);
        } else if (timer === null) {
          // The second photo to arrive is what turns a still into a montage.
          schedule();
        }
      };
      probe.onerror = () => {
        photo.ok = false;
      };
      probe.src = photo.url;
    }
  }

  /**
   * Set the message at the largest size that still fits its box.
   *
   * Measured, not estimated. The first pass at this stepped the type through
   * three bands by character count and the second computed a size from the
   * square root of the length — both are guesses about how many lines a
   * particular message will take at a particular width, and both overflowed
   * the moment the window was not the shape they were tuned for. The box is
   * the only thing that knows: eight halvings of the range settle it to under
   * a pixel, they cost eight layouts of one paragraph, and they happen once
   * per message rather than per frame.
   *
   * The floor is 24px rather than DESIGN.md's 32: 32 is the floor for the
   * 1080p tab this is designed for, where the longest of the real messages
   * lands near 39px and never reaches it. A smaller window is somebody
   * checking the Desktop on a laptop, and a message that is slightly too small
   * there is better than one with its last line cut off.
   */
  /**
   * One size for every message, fitted to the longest.
   *
   * Fitting each message on its own looked reasonable in isolation and wrong
   * in sequence: the room watched the type jump between 32px and 75px from one
   * person to the next, which reads as some messages mattering more than
   * others. They do not, and a farewell is the last place to imply it.
   *
   * So the fit is done once against the longest message in the set, and every
   * message is set at that. `longest` is on the wire precisely because a
   * surface only holds the message it is showing and cannot measure the rest.
   *
   * The probe is a synthetic string of that length rather than the real text,
   * which the Desktop must not have early — a host skips a message the room
   * has not seen, and a Desktop that had been sent it could leak it. Word
   * lengths differ, so the estimate is approximate; it is biased long, and a
   * message that ends up slightly smaller than it had to be is a much better
   * failure than one with its last line cut off.
   */
  function fitMessage(): void {
    if (message.hidden) return;
    const target = Math.max(longestChars, message.textContent?.length ?? 0);
    const real = message.textContent ?? "";
    // "lorem ipsum " repeated is close enough to English word lengths for a
    // wrapping estimate, and it never contains a word longer than the box.
    let probe = "";
    while (probe.length < target) probe += "lorem ipsum dolor sit amet ";
    message.textContent = probe.slice(0, target);
    let lo = KUDO_MIN_PX;
    let hi = KUDO_MAX_PX;
    const room = messageBox.clientHeight;
    for (let i = 0; i < 8; i += 1) {
      const mid = (lo + hi) / 2;
      message.style.fontSize = `${mid.toFixed(1)}px`;
      if (message.scrollHeight <= room) lo = mid;
      else hi = mid;
    }
    message.textContent = real;
    message.style.fontSize = `${Math.floor(lo)}px`;
  }

  // The Desktop is resized once, while it is being set up and put on the
  // share, and never after that — but that once is the moment the fit would
  // otherwise be wrong for the rest of the afternoon.
  const refit = new ResizeObserver(() => fitMessage());
  refit.observe(card);

  function stopMontage(): void {
    clearTimer();
    photos = [];
    shown = -1;
    pending = null;
    montage.hidden = true;
    for (const layer of layers) {
      layer.classList.remove("is-on");
      layer.removeAttribute("src");
      layer.alt = "";
    }
  }

  return {
    node,
    update(state) {
      const so = state.sendoff;
      if (!so) {
        // The segment is up and the event staged no send-off. Not a blank
        // screen: a blank screen in front of the room is a bug the host
        // cannot diagnose from where they are standing.
        node.dataset["phase"] = "none";
        node.dataset["shows"] = "words";
        setText(kicker, "Send-off");
        setText(message, "Nothing staged for this event.");
        message.hidden = false;
        messageBox.hidden = false;
        from.hidden = true;
        counter.hidden = true;
        signature = "";
        stopMontage();
        fadeOutMusic();
        // Not fitted: a notice is not the content, and this one is the only
        // line on the Desktop that should not fill the screen. Clearing the
        // inline size hands it back to the stylesheet.
        message.style.fontSize = "";
        return;
      }

      node.dataset["phase"] = so.phase;
      longestChars = so.longest;
      setText(kicker, so.phase === "title" ? "Farewell" : so.name);
      // On the title card the name is the thing on the screen, so it is the
      // heading rather than the kicker above one — see `.s-farewell-name`.
      setText(farewellName, so.name);
      setText(kickerSub, so.subtitle ?? "");
      kickerSub.hidden = (so.subtitle ?? "") === "";
      farewellName.hidden = so.phase !== "title";

      /* ---- the montage ---- */
      // The list is what a montage is built from, so the signature is the
      // list and the phase — not the slide. A run that re-preloaded on every
      // advance would fetch forty-three photographs forty-three times.
      const sig = `${so.phase}|${so.photos.join("|")}`;
      if (sig !== signature) {
        signature = sig;
        if (so.photos.length > 0) startMontage(state.sid, so.photos, so.phase, so.seconds);
        else stopMontage();
      }
      // Within the run the server names the photograph, or none: a message
      // slide clears the picture rather than leaving the last one behind it.
      if (so.phase === "run") {
        if (so.photo !== null) showKey(so.photo);
        else {
          for (const layer of layers) layer.classList.remove("is-on");
          montage.hidden = true;
          shown = -1;
          pending = null;
        }
      }

      /* ---- the music ---- */
      // `music` is non-null only during the montage — the wire sees to that —
      // so this both starts it and, on the first message, ends it.
      if (so.music !== null) startMusic(assetUrl(state.sid, so.music), so.music);
      else fadeOutMusic();

      /* ---- the words ---- */
      const k = so.kudo;
      if (k !== null) {
        setText(message, k.message);
        setText(from, k.from);
        message.hidden = false;
        from.hidden = false;
      } else {
        from.hidden = true;
        const line = so.phase === "closing" || so.phase === "done" ? so.line : null;
        setText(message, line ?? "");
        message.hidden = line === null || line === "";
      }
      // The box goes with the words. Left standing it would keep its share of
      // the card, and the Farewell name would sit against the top edge.
      messageBox.hidden = message.hidden;
      fitMessage();

      // Whether a photograph is up, which is what decides the card's shape —
      // a caption band under a picture, or the whole screen for the words.
      // Phase alone cannot say it any more: the run is both, slide by slide.
      node.dataset["shows"] =
        so.phase === "closing" || (so.phase === "run" && so.photo !== null) ? "photo" : "words";

      // "9 of 13", and on a split message which part of it this is — the room
      // should be able to tell a paragraph that continues from one that ended.
      const part = so.parts > 1 ? ` · ${so.part}/${so.parts}` : "";
      setText(counter, so.kudo !== null ? `${so.index} of ${so.total}${part}` : "");
      counter.hidden = so.kudo === null;
    },
    stop() {
      stopMontage();
      stopMusic();
      refit.disconnect();
    },
  };
}


function sceneCard(kicker: string, line: string): Scene {
  const title = h("h1", { class: "display s-title" });
  const node = h("section", { class: "s-stage s-card" }, [
    h("p", { class: "s-kicker label", text: kicker }),
    title,
    h("p", { class: "s-line", text: line }),
  ]);
  return {
    node,
    update(state) {
      setText(title, state.title);
    },
  };
}

function sceneLobby(): Scene {
  const title = h("h1", { class: "display s-title" });
  // Under the title, and hidden when a session set none: an empty line between
  // the name and the join code is a gap the eye reads as a mistake.
  const subtitle = h("p", { class: "s-subtitle", attrs: { hidden: true } });
  const url = h("p", { class: "mono s-join-url" });
  const canvas = h("canvas", { class: "s-qr" });
  const qrWrap = h("div", { class: "s-qr-wrap" }, [canvas]);
  const count = h("span", { class: "mono s-count" });
  const names = h("div", { class: "s-names" });

  // The code arrives with the first state, so the link is drawn in update()
  // rather than here. `drawn` keeps the canvas from being re-encoded on every
  // roster change — the QR only changes if the code does.
  let drawn: string | null = null;
  setText(url, "Ask the host for the join link");
  qrWrap.hidden = true;

  function showJoin(link: string | null): void {
    setText(url, link ?? "Ask the host for the join link");
    if (link === drawn) return;
    drawn = link;
    if (link === null) {
      qrWrap.hidden = true;
      return;
    }
    const code = encodeQr(link);
    // A QR survives compression surprisingly well if it is large enough, and
    // not at all if it is not. 360px is the floor.
    if (code) {
      drawQr(canvas, code, { targetPx: 420 });
      qrWrap.hidden = false;
    } else {
      qrWrap.hidden = true;
    }
  }

  // The event's promo card, when the event staged one. The frame is given no
  // capability at all: a bare `sandbox` is the empty allow-list — no scripts,
  // no same-origin, no forms, no popups, no top-level navigation. The page is
  // the host's own, but the Desktop is the surface being screen-shared, and
  // there is no reason an embedded poster should be able to do anything but
  // draw itself. If a card ever needs its own scripts to render, the narrowest
  // fix is `sandbox="allow-scripts"` and nothing else — never alongside
  // `allow-same-origin`, which together hand the page the Desktop's origin and
  // undo the whole attribute.
  //
  // No `loading="lazy"`. It would buy nothing — the frame is given a src only
  // once there is a card and it is about to be the second thing on the screen,
  // never below a fold — and it would make the load conditional on the
  // element's box, which is exactly the thing that is in flux here: the frame
  // is revealed and given its src in the same task, so at the moment the load
  // is queued it is still laid out as `hidden`. A lazy frame that decides it
  // is nowhere near the viewport does not error and does not log. It just
  // stays an empty white panel on a shared screen.
  const promo = h("iframe", {
    class: "s-promo",
    title: "Event promo card",
    attrs: { sandbox: "" },
  });
  /**
   * The card, whole, at whatever size the lobby can give it.
   *
   * A promo card is a poster: the one staged for this event lays out at
   * 700 x 1267 with 16px of body padding each side and 18px top and bottom,
   * so 732 x 1303 of content, and it is *tall*. The lobby's slot on a 1512px
   * window is 575 x 695. A frame that is 575 wide needs 1041 of height to
   * draw that poster, gets 695, and loses the bottom third — which on this
   * surface is a poster with its call to action cut off, in front of the
   * room, and no error anywhere.
   *
   * So the frame is given the card's own logical viewport and scaled to fit
   * the slot, which is the same trick the console's phone preview uses: the
   * page inside is laid out at the size it was designed for and the whole of
   * it is shrunk, rather than the page being reflowed into a box it was never
   * written for.
   *
   * The size cannot be measured. `sandbox=""` with no `allow-same-origin`
   * means the parent cannot read the frame's `scrollHeight`, and a card with
   * no scripts in it cannot post its own size out — both of which are the
   * sandbox doing its job. It is not weakened to get a number: this is the
   * surface being screen-shared, and an embedded poster has no business
   * holding the Desktop's origin. 732 x 1303 is the card's logical size, and
   * a card that is a different shape is letterboxed inside the slot rather
   * than clipped by it.
   */
  const PROMO_W = 732;
  const PROMO_H = 1303;
  const promoWrap = h("div", { class: "s-promo-wrap" }, [promo]);
  promoWrap.hidden = true;

  /**
   * `zoom`, not `transform: scale()`.
   *
   * Measured, because the obvious one is silently wrong: a `sandbox=""` frame
   * is an opaque origin, which makes it an out-of-process frame, and Chrome
   * renders a scaled one as a blank rectangle — the card loads (154KB on the
   * wire, `load` fires) and nothing is painted. On the Desktop that is a white
   * panel on a shared screen with no error anywhere, which is worse than the
   * clipping it was meant to fix. `zoom` scales the frame's layout instead of
   * its raster, the frame paints, and the box the flexbox centres is the
   * scaled one — so the letterboxing is the wrapper's job and there is no
   * translate to keep in step.
   *
   * A browser without `zoom` gets the frame at the slot's own size, which is
   * the behaviour that shipped before this: reflowed, and clipped if the card
   * is taller than the slot. No worse than it was, and it is Chrome that puts
   * this on a wall.
   */
  const canZoom = typeof CSS !== "undefined" && CSS.supports("zoom", "0.5");
  let promoSrc: string | null = null;
  let promoZoom = "";
  let repaintTimer: ReturnType<typeof setTimeout> | null = null;

  function fitPromo(): void {
    const box = promoWrap.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return;
    if (!canZoom) {
      promo.style.width = "100%";
      promo.style.height = "100%";
      return;
    }
    const scale = Math.min(box.width / PROMO_W, box.height / PROMO_H).toFixed(4);
    if (scale === promoZoom) return;
    promoZoom = scale;
    promo.style.zoom = scale;
    // A frame whose box changes *after* it has loaded stops painting, the
    // same way one sized in the same task as its `src` never starts — so a
    // resized Desktop reloads the card rather than showing a white panel.
    // Debounced, because a window drag is a hundred resize events and this
    // costs a request; and it only happens while somebody is setting the
    // screen up, never mid-show.
    if (promoSrc === null) return;
    if (repaintTimer !== null) clearTimeout(repaintTimer);
    repaintTimer = setTimeout(() => {
      repaintTimer = null;
      if (promoSrc !== null) promo.src = promoSrc;
    }, 250);
  }

  // The slot changes with the window, and the Desktop is run at 1080p as well
  // as on a laptop. One observer covers both, and the load is caught too: the
  // frame is revealed and given its src in the same task, before layout.
  new ResizeObserver(() => fitPromo()).observe(promoWrap);
  promo.addEventListener("load", fitPromo);

  /**
   * Show the frame only once the session is known to have a card.
   *
   * A HEAD probe rather than showing it and hiding on the iframe's `error`
   * event, because that event does not fire for this: a 404 with a body is a
   * successful load as far as the element is concerned, so the frame would
   * fire `load` and render `{"error":"not_found"}` on a wall in front of the
   * room. HEAD costs one request and answers the actual question.
   */
  let settled: string | null = null;
  let asking = false;
  function offerPromo(sid: string): void {
    if (sid === "" || sid === settled || asking) return;
    asking = true;
    const src = `/api/sessions/${encodeURIComponent(sid)}/promo`;
    void fetch(src, { method: "HEAD" })
      .then((res) => {
        // A 404 is the definitive answer — this event staged no card — and it
        // is never asked again. Anything else is left unsettled on purpose, so
        // the next state frame asks once more: a blip while the lobby is up
        // must not be the thing that decides, for the whole afternoon, that
        // there is no poster.
        if (res.status === 404) {
          settled = sid;
          return;
        }
        if (!res.ok) return;
        settled = sid;
        promoWrap.hidden = false;
        // The layout only shrinks the join details and the QR once there is a
        // third thing to make room for.
        setAttr(node, "data-promo", "yes");
        // Sized *before* it is pointed at anything. A frame whose box changes
        // in the same task as its `src` lands in a state Chrome does not
        // repaint out of — the card loads and the panel stays blank white —
        // and the slot is measurable as soon as the wrapper is visible.
        fitPromo();
        promoSrc = src;
        promo.src = src;
      })
      // No card, no network, no server yet: the lobby is the lobby it has
      // always been. Nothing on this screen is allowed to fail visibly.
      .catch(() => {})
      .finally(() => {
        asking = false;
      });
  }

  const node = h("section", { class: "s-stage s-lobby" }, [
    h("div", { class: "s-lobby-left" }, [
      h("p", { class: "s-kicker label", text: "Join" }),
      title,
      subtitle,
      url,
      h("p", { class: "s-lobby-count" }, [
        count,
        h("span", { class: "label", text: "joined" }),
      ]),
      names,
    ]),
    qrWrap,
    promoWrap,
  ]);

  return {
    node,
    update(state) {
      offerPromo(state.sid);
      showJoin(joinUrl(state.joinCode));
      setText(title, state.title);
      setText(subtitle, state.subtitle ?? "");
      subtitle.hidden = (state.subtitle ?? "") === "";
      setText(count, String(state.roster.length));
      // Nicknames as they arrive. Text, never markup.
      replace(
        names,
        state.roster
          .slice(-40)
          .map((r) => h("span", { class: "s-name", text: r.nickname })),
      );
    },
  };
}

function sceneHolding(): Scene {
  const title = h("h1", { class: "display s-title s-title-huge" });
  const line = h("p", { class: "s-line s-line-big" });
  const node = h("section", { class: "s-stage s-holding" }, [
    h("p", { class: "s-kicker label" }, [
      h("span", { class: "dot", attrs: { "data-conn": "on" } }),
      " live",
    ]),
    title,
    line,
  ]);
  return {
    node,
    update(state) {
      setText(title, state.holding?.title ?? state.title);
      setText(line, state.holding?.line ?? "");
    },
  };
}

/* ------------------------------------------------------------------ */
/* Trivia                                                              */
/* ------------------------------------------------------------------ */

const TRIVIA_TICK_MS = 200;

/**
 * The question, large, with the answer count climbing — then the reveal.
 *
 * The two halves of the segment share the tiles: while the question is open
 * they are four shape-and-colour tiles, and at the reveal each one grows a
 * bar behind it in its own hue with the count at the end. DESIGN.md wants
 * "bars, not numbers, for distributions" and "the correct tile stays lit,
 * others dim", and keeping the same four rows means the correct answer is in
 * the place the room was already looking.
 *
 * Nothing here glides. The bar widths are set on a state change and the timer
 * ticks; video compression turns a smooth slide into a smear.
 */
function sceneTrivia(): Scene {
  const kicker = h("p", { class: "s-kicker label" });
  const round = h("p", { class: "s-trivia-round label", attrs: { hidden: true } });
  const question = h("h1", { class: "display s-question" });
  const rows = h("div", { class: "s-answers" });

  const timerNum = h("span", { class: "mono s-timer-num" });
  const timerFill = h("div", { class: "s-timer-fill" });
  const timer = h("div", { class: "s-timer" }, [
    h("div", { class: "s-timer-track" }, [timerFill]),
    timerNum,
  ]);

  const countFill = h("div", { class: "s-count-fill" });
  const countText = h("span", { class: "mono s-count-text" });
  const count = h("div", { class: "s-answered" }, [
    h("div", { class: "s-count-track" }, [countFill]),
    countText,
  ]);

  const note = h("p", { class: "s-note", attrs: { hidden: true } });
  const podium = h("ol", { class: "s-rows s-trivia-podium", attrs: { hidden: true } });

  const node = h("section", { class: "s-stage s-trivia" }, [
    h("div", { class: "s-trivia-head" }, [kicker, round]),
    question,
    rows,
    timer,
    count,
    note,
    podium,
  ]);

  interface Row {
    el: HTMLElement;
    bar: HTMLElement;
    tally: HTMLElement;
  }
  let built = "";
  let built_rows: Row[] = [];
  let ticker: ReturnType<typeof setInterval> | null = null;

  const buildRows = (trivia: TriviaView): void => {
    const signature = `${trivia.index}:${trivia.answers.join("\u0000")}`;
    if (signature === built) return;
    built = signature;
    built_rows = answerTiles(trivia.answers).map((tile) => {
      const bar = h("div", { class: "s-answer-bar" });
      const tally = h("span", { class: "mono s-answer-tally" });
      const el = h(
        "div",
        {
          class: "s-answer",
          attrs: { style: `--tile:${tile.hue};--tile-ink:${tile.ink}` },
        },
        [
          bar,
          h("span", { class: "s-answer-shape", attrs: { "aria-hidden": "true" }, text: tile.shape }),
          h("span", { class: "s-answer-text", text: tile.text }),
          tally,
        ],
      );
      return { el, bar, tally };
    });
    replace(rows, built_rows.map((r) => r.el));
    rows.dataset["count"] = String(built_rows.length);
  };

  const paintTimer = (trivia: TriviaView): void => {
    if (trivia.suddenDeath || trivia.phase !== "open") {
      timer.hidden = true;
      return;
    }
    const left = remainingMs(trivia.closesAt, serverNow());
    if (left === null) {
      timer.hidden = true;
      return;
    }
    timer.hidden = false;
    setText(timerNum, formatCountdown(left));
    timerFill.style.width = `${(timerFraction(trivia, serverNow()) ?? 0) * 100}%`;
    setClass(timer, "urgent", left <= 5_000);
  };

  let lastState: RenderState | null = null;

  const paint = (state: RenderState): void => {
    const trivia = state.trivia;
    if (trivia === undefined || trivia.phase === "idle" || trivia.text === "") {
      setText(kicker, "Trivia");
      round.hidden = trivia?.round === null || trivia?.round === undefined;
      if (trivia?.round) setText(round, trivia.round.name);
      setText(question, trivia?.round?.startsHere === true ? trivia.round.name : "Coming up");
      replace(rows, []);
      built = "";
      timer.hidden = true;
      count.hidden = true;
      note.hidden = true;
      podium.hidden = true;
      return;
    }

    setText(kicker, questionLabel(trivia));
    round.hidden = trivia.round === null;
    if (trivia.round) setText(round, trivia.round.name);
    setText(question, trivia.text);
    buildRows(trivia);
    paintTimer(trivia);

    const answered = trivia.answered ?? 0;
    const eligible = trivia.eligible ?? 0;
    const revealed = trivia.phase === "revealed";
    count.hidden = revealed;
    if (!revealed) {
      setText(countText, `${answered} of ${eligible}`);
      countFill.style.width = eligible > 0 ? `${(answered / eligible) * 100}%` : "0%";
    }

    const distribution = trivia.distribution ?? [];
    const correct = revealed ? (trivia.correct ?? []) : [];
    // The widest bar is the full width, so the shape of the room's answer
    // reads at a glance rather than against an invisible axis.
    const top = Math.max(1, ...distribution);
    built_rows.forEach((row, i) => {
      const n = distribution[i] ?? 0;
      const isCorrect = correct.includes(i);
      setClass(row.el, "hit", revealed && isCorrect);
      setClass(row.el, "dim", revealed && !isCorrect);
      setAttr(row.el, "data-revealed", revealed ? "yes" : "no");
      row.bar.style.width = revealed ? `${(n / top) * 100}%` : "0%";
      setText(row.tally, revealed ? String(n) : "");
    });

    const text = trivia.note ?? "";
    note.hidden = !revealed || text === "";
    setText(note, text);

    const rowsOut = revealed ? (trivia.podium ?? []) : [];
    podium.hidden = rowsOut.length === 0;
    replace(
      podium,
      rowsOut.map((r) =>
        h("li", { class: "s-row s-trivia-row" }, [
          h("span", { class: "mono s-rank", text: String(r.rank) }),
          h("span", { class: "display s-name-big", text: r.nickname }),
          h("span", { class: "mono s-total", text: String(r.points) }),
        ]),
      ),
    );

    if (trivia.suddenDeath && trivia.suddenDeathWinner !== null) {
      // SPEC: sudden death shows the winner's name on the big screen, and
      // nothing about points, because none moved.
      setText(question, trivia.suddenDeathWinner);
      setText(kicker, "Sudden death");
    }
  };

  ticker = setInterval(() => {
    if (lastState?.trivia) paintTimer(lastState.trivia);
  }, TRIVIA_TICK_MS);

  return {
    node,
    update(state) {
      lastState = state;
      paint(state);
    },
    stop() {
      if (ticker !== null) clearInterval(ticker);
      ticker = null;
    },
  };
}


/* ------------------------------------------------------------------ */
/* Hashi Arcade                                                        */
/* ------------------------------------------------------------------ */

const ARCADE_TICK_MS = 60;

/**
 * The doll: a twelve-foot Terraform logo.
 *
 * The mark, drawn rather than fetched, so it survives with no network and no
 * font. DESIGN.md rules out figures, silhouettes and anything else from the
 * show; a product logo on a stand is the joke, and it is the only version of
 * the doll that is funny rather than grim.
 *
 * Its "head" turning is a rotation about the vertical axis, which reads as a
 * turn at any size. The wipe across the screen is the real warning; this is
 * the thing the room watches while the wipe happens.
 */
function doll(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 128 148");
  svg.setAttribute("class", "s-doll");
  svg.setAttribute("aria-hidden", "true");
  // The Terraform mark: four parallelograms, two stacked and two beside them.
  const bars: [number, number, number][] = [
    [8, 26, 1],
    [48, 26, 1],
    [48, 74, 1],
    [88, 50, 1],
  ];
  for (const [x, y] of bars) {
    const path = document.createElementNS(ns, "path");
    path.setAttribute(
      "d",
      `M${x} ${y} l32 18 v40 l-32 -18 z`,
    );
    path.setAttribute("fill", "currentColor");
    svg.appendChild(path);
  }
  return svg;
}

/**
 * The arcade on the big screen.
 *
 * The grid is the centrepiece: sixty three-digit numbers, green on the Floor,
 * gold in the Lounge, grey away, with a thin pink strike on anyone drained
 * this round. DESIGN.md calls it the dormitory, and it is the arcade's
 * scoreboard, roster and mood in one.
 *
 * Plan / Apply takes the screen over entirely, because in that round the
 * screen *is* the light.
 */
function sceneArcade(): Scene {
  const kicker = h("p", { class: "s-kicker label" });
  const title = h("h1", { class: "display s-title" });
  const cardLines = h("div", { class: "s-arc-card" });
  const stair = h("div", { class: "s-stair", attrs: { "aria-hidden": "true" } });

  /* the grid */
  const grid = h("div", { class: "s-grid", role: "list" });
  const counts = h("p", { class: "mono s-grid-counts" });

  /* recruitment */
  const cue = h("p", { class: "s-arc-cue", attrs: { "aria-hidden": "true" } });
  const recruitCount = h("p", { class: "mono s-arc-count" });
  const recap = h("ol", { class: "s-recap", attrs: { hidden: true } });

  /* plan / apply */
  const sign = h("h2", { class: "display s-sign" });
  const signGlyph = h("span", { class: "s-sign-glyph", attrs: { "aria-hidden": "true" } });
  const dollWrap = h("div", { class: "s-doll-wrap" }, [doll()]);
  const wipe = h("div", { class: "s-wipe", attrs: { "aria-hidden": "true" } });
  const crossed = h("p", { class: "mono s-crossed" });
  /**
   * The runner ticker: the leading few, in the corner of the light.
   *
   * SPEC.md's Lounge is the arcade's best idea and Plan / Apply was where it
   * went quiet — the light covers the dormitory grid for 75 seconds, so the
   * room could read PLAN, LOCKED and "N of M across" and nothing else. Nobody,
   * backer or runner, could see who was on 90 and who was on 30. The finish
   * order is already a public surface, and this is the same surface a few
   * seconds earlier.
   *
   * It is a corner and it stays one. The wipe and the word are the round's
   * safety signal, so the ticker carries no background of its own — the wipe
   * runs underneath it and the ink is the same on both faces — it sits clear
   * of the centred sign row, and it is out of the drain log's way at the
   * bottom. Anything that dimmed the turn from green to pink to make room for
   * a leaderboard would be trading the warning for the scoreboard.
   */
  const runnerBoard = h("ol", { class: "mono s-ticker", attrs: { hidden: true } });
  const light = h("section", { class: "s-light", attrs: { hidden: true } }, [
    wipe,
    runnerBoard,
    dollWrap,
    h("div", { class: "s-sign-row" }, [signGlyph, sign]),
    crossed,
  ]);

  /* the Glass Bridge */
  const bridgeClock = h("p", { class: "mono s-bridge-clock" });
  const bridgeRow = h("div", { class: "s-bridge-row", role: "list" });
  const bridgeWaves = h("div", { class: "s-waves" });
  const bridgeRecap = h("ol", { class: "s-bridge-recap", attrs: { hidden: true } });
  /**
   * The bridge sits in the ordinary document flow and the dormitory grid
   * steps aside for it, rather than the bridge being laid over the top.
   *
   * Plan / Apply's `.s-light` is `position: absolute; inset: 0` because in
   * that round the screen *is* the light — that is the round's whole design.
   * Nothing else on this surface may do it: a full-bleed panel over the grid
   * is how the big screen ends up showing an empty room, and it is a bug no
   * test can see. The bridge is the round's picture, so it takes the space
   * the grid was using and gives it back at the reveal.
   */
  const bridge = h("section", { class: "s-bridge", attrs: { hidden: true } }, [
    bridgeClock,
    bridgeRow,
    bridgeRecap,
    bridgeWaves,
  ]);

  /* Unseal */
  const unsealHead = h("p", { class: "mono s-unseal-head" });
  const unsealTiles = h("div", { class: "s-tins", role: "list" });
  const unsealRecap = h("ol", { class: "s-unseal-recap", attrs: { hidden: true } });
  /**
   * The +10 board, which is a *reveal*.
   *
   * It used to live on the tiles and fill in as tins came open, and that was
   * the round's one leak: who is fastest in a shape is a result, and a result
   * on the screen the whole room is reading is a result the Lounge can bet on
   * for a certainty. The server no longer sends it to this surface before the
   * reveal (see `arcadeUnsealFor`), and the tiles step aside at the reveal —
   * so the board needs a line of its own, here, where the words are.
   */
  const unsealFastest = h("p", { class: "mono s-unseal-fastest", attrs: { hidden: true } });
  /**
   * The four tins, as the room may see them.
   *
   * Counts, never people: SPEC.md's conceit is that you pick before you know
   * the word, and a shape is a word length — so "Player 017 took the
   * umbrella" on a screen three metres from Player 017 is a hint nobody
   * agreed to give. What the room gets is four tiles filling up, which is the
   * round card's whole animation, and the +10 board at the end.
   *
   * In the flow, not over the grid: the dormitory steps aside for this the
   * way it does for the bridge. A full-bleed panel over the grid is how the
   * Desktop ends up showing the room an empty rectangle.
   */
  const unseal = h("section", { class: "s-unseal", attrs: { hidden: true } }, [
    unsealHead,
    unsealTiles,
    unsealFastest,
    unsealRecap,
  ]);

  /* Tug of Raft */
  const tugHead = h("p", { class: "mono s-tug-head" });
  const tugRopeTrack = h("div", { class: "s-rope-track" });
  const tugRopeKnot = h("div", { class: "s-rope-knot", attrs: { "aria-hidden": "true" } });
  const tugSideA = h("div", { class: "s-cluster", attrs: { "data-side": "a" } });
  const tugSideB = h("div", { class: "s-cluster", attrs: { "data-side": "b" } });
  const tugPulse = h("div", { class: "s-pulse", attrs: { "aria-hidden": "true" } });
  const tugRopeRow = h("div", { class: "s-rope" }, [
    tugRopeTrack,
    tugRopeKnot,
    tugPulse,
  ]);
  const tugWins = h("p", { class: "mono s-tug-wins" });
  /**
   * The rope, the heartbeat and the two clusters.
   *
   * The pulse is drawn from the server's beat grid on this surface exactly as
   * it is on every phone — `pullStartedAt + n * beatMs` against the corrected
   * clock — and for a reason this surface makes obvious: the Desktop is the
   * heartbeat the room is watching, and if it ran its own interval the room
   * would be tapping to a beat the server is not counting. There is one
   * clock in this round.
   */
  const tug = h("section", { class: "s-tug", attrs: { hidden: true } }, [
    tugHead,
    h("div", { class: "s-tug-arena" }, [tugSideA, tugRopeRow, tugSideB]),
    tugWins,
  ]);

  /**
   * The win beat, which this surface did not have.
   *
   * The drain log below is DESIGN.md's error beat — `--miss` coral, bordered,
   * the way a terminal says it — and a tin coming open is not that beat. Red
   * is the show's blood, DESIGN.md spends it on the 400 ms error and the
   * trivia reveal and nowhere else, so this is the house speaking instead: the
   * `>` prompt the round card already uses, the house's purple, and one rule
   * down the left rather than a box. It is told apart from a drain by its
   * shape and its sentence before its hue, because nothing on this surface may
   * be carried by colour alone.
   *
   * In the flow, under whichever panel is up, never laid over it — the same
   * rule the bridge, the tins and the inline drain log keep. A panel over this
   * surface is how the Desktop ends up showing the room a rectangle.
   */
  const winLog = h("div", { class: "s-win-log", attrs: { hidden: true } });

  /* the drain, verbatim */
  const drainLog = h("div", { class: "s-drain-log", attrs: { hidden: true } });

  const main = h("div", { class: "s-arc-main" }, [
    cue,
    recruitCount,
    cardLines,
    recap,
  ]);

  const node = h("section", { class: "s-stage s-arcade" }, [
    stair,
    h("div", { class: "s-arc-head" }, [kicker, title]),
    main,
    bridge,
    unseal,
    tug,
    // Directly under the round's own picture, because that is what it is about:
    // the rope the room is watching, or the four tins it is watching fill.
    winLog,
    grid,
    counts,
    light,
    // After the light, deliberately: in Plan / Apply the screen *is* the
    // light and covers everything, and a drain during that round is exactly
    // when the error has to be readable. So it sits on top of it.
    drainLog,
  ]);

  let ticker: ReturnType<typeof setInterval> | null = null;
  let lastState: RenderState | null = null;
  let struck = new Set<string>();
  let drainTimer: ReturnType<typeof setTimeout> | null = null;
  // The win beat's memory: the last frame's pulls won, and the last frame's
  // open tins per shape. Both start empty rather than at zero, because "no
  // reading yet" and "a reading of nothing" are different things here — see
  // `paintWinBeat`.
  let winRound = -1;
  let tugWinsSeen: readonly [number, number] | null = null;
  let tinsOpenSeen: Map<string, number> | null = null;
  let winTimer: ReturnType<typeof setTimeout> | null = null;

  const paintGrid = (state: RenderState, arcade: ArcadeView): void => {
    const entries = gridEntries(arcade, state.roster);
    replace(
      grid,
      entries.map((e) =>
        h(
          "div",
          {
            class: "s-cell",
            role: "listitem",
            attrs: {
              "data-standing": e.standing,
              "data-away": e.away ? "yes" : "no",
              "data-struck": e.struck ? "yes" : "no",
              // The number is the label. DESIGN.md: the nickname is on the
              // phone only, where the person it belongs to is the only reader.
              "aria-label": `${playerName(e.playerNumber)}${
                e.standing === "drained" ? ", in the Lounge" : ", on the Floor"
              }${e.backers > 0 ? `, backed by ${e.backers}` : ""}`,
            },
          },
          [
            h("span", { class: "mono s-cell-num", text: e.tag }),
            e.backers > 0
              ? h("span", { class: "mono s-cell-backers", text: `×${e.backers}` })
              : null,
          ],
        ),
      ),
    );
    setText(counts, `${arcade.onFloor} on the Floor · ${arcade.inLounge} in the Lounge`);
  };

  /**
   * A drain, verbatim, mono, red — the way it looks in a real terminal.
   *
   * SPEC.md asks for exactly that, and DESIGN.md bounds it: red is the show's
   * blood and ours is `--miss` coral, used only in the error beat. So this is
   * a short-lived line over the grid, not a state the screen sits in.
   */
  const paintDrains = (arcade: ArcadeView): void => {
    const now = new Set(
      arcade.grid.filter((c) => c.struck).map((c) => String(c.playerNumber)),
    );
    const fresh = [...now].filter((n) => !struck.has(n));
    struck = now;
    if (fresh.length === 0) return;
    const g = arcade.glass;
    /**
     * The bridge's own error, which DESIGN.md writes per player: *Pane 4 was
     * not tempered. Player 017 drained.*
     *
     * The pane it names is that player's own `position` — the step they were
     * facing — and never the bridge's open step: a drain for not stepping
     * arrives on the frame that has already moved the bridge on, so the open
     * step is one too far by the time this runs.
     *
     * Two ways off the bridge and two lines, told apart by whether the step
     * they were facing is still the open one. Falling is a pane that was not
     * tempered; running the clock out is a pane that was not chosen, and
     * telling somebody they stood on a pane they never touched would be the
     * screen making something up.
     *
     * *Which* of the two panes it was is not said, and is not known here —
     * see `ArcadeGlassView`. The room still has two waves in it who have not
     * crossed.
     */
    const glassLine = (n: number): string => {
      const cell = arcade.grid.find((c) => c.playerNumber === n);
      const at = (cell ? (g?.position?.[cell.pid] ?? 0) : 0) + 1;
      return g?.step === at - 1 ? HOUSE.glassFall(at, n) : HOUSE.glassTimeout(at, n);
    };
    // On the bridge the log goes *in the flow*, under the bridge, rather than
    // over the top of it. A panel laid over this surface is how the big
    // screen ends up showing the room an empty rectangle, and here it would
    // cover the one thing waves 2 and 3 are told to read — the pane labels,
    // and which of them broke. The bridge shrinks for four seconds instead.
    //
    // Three lines at most, because a step that closes can drain half a wave
    // and the room reads two lines of a terminal, not nine.
    // Unseal's error is its own — DESIGN.md: *The tin has shattered. Player 017
    // drained.* — and the state-lock error belongs to Plan / Apply alone. It
    // goes in the flow under the tins for the reason the bridge's does: a
    // panel over this surface is how the Desktop shows the room a rectangle.
    //
    // The shatter and not the crack that precedes it: this round is two
    // strikes, and the first one stays between the tin and the phone holding it.
    // A Desktop that named whoever is one tap from the Lounge would be handing
    // the Lounge a result to bet against for nothing.
    const tins = arcade.unseal !== undefined;
    setClass(drainLog, "inline", g !== undefined || tins);
    replace(drainLog, [
      g || tins
        ? null
        : h("p", { class: "mono s-drain-error", text: STATE_LOCK_ERROR }),
      ...fresh
        .map(Number)
        .sort((a, b) => a - b)
        .slice(0, g || tins ? 3 : 6)
        .map((n) =>
          h("p", {
            class: "mono s-drain-who",
            text: g ? glassLine(n) : tins ? HOUSE.unsealShatter(n) : HOUSE.drained(n),
          }),
        ),
    ]);
    drainLog.hidden = false;
    if (drainTimer !== null) clearTimeout(drainTimer);
    // Four seconds: DESIGN.md's dwell floor, because video latency means a
    // thing that shows for two seconds was never seen.
    drainTimer = setTimeout(() => {
      drainLog.hidden = true;
      drainTimer = null;
    }, 4_000);
  };

  /**
   * One house line in the round card's own shape — the prompt, then the
   * sentence — with an optional mono line of counts under it.
   *
   * The sentence is the beat and the counts are the evidence, which is the
   * order the room reads them in: the house says what happened, and the line
   * under it is the number already on the panel above, on the frame it moved.
   */
  const winLine = (line: string, detail: string | null): HTMLElement =>
    h("div", { class: "s-win-beat" }, [
      h("p", { class: "mono s-win-said" }, [
        h("span", { class: "s-prompt", attrs: { "aria-hidden": "true" }, text: ">" }),
        h("span", { text: line }),
      ]),
      detail === null ? null : h("p", { class: "mono s-win-count", text: detail }),
    ]);

  /**
   * A pull being won, and a tin coming open: the two beats this screen had no
   * words for while it narrated every way to lose.
   *
   * Both are read as a **diff against the last frame**, which is the reading
   * the phone already does in `paintTug`: the engine sends state and never
   * events, so the only place a win exists is between two frames. Two
   * consequences, and they are the whole of why this function keeps memory of
   * its own:
   *
   * The first frame of a round seeds the numbers and says nothing. A Desktop
   * tab reopened three pulls in — the host reloads it, the share is restarted
   * — must not narrate the three pulls it was not there for, and `null` rather
   * than `[0, 0]` is what tells those two cases apart.
   *
   * A round restart forgets the last result, because the rope and the tins are
   * new and the previous run's closing pull is not news about this one.
   * `roundIndex` is the key that says so: `startRound` counts every round it
   * starts, so running Tug of Raft twice is two indices and not one, and the
   * second run's wins start from `null` rather than from the first run's three.
   */
  const paintWinBeat = (arcade: ArcadeView): void => {
    if (arcade.roundIndex !== winRound) {
      winRound = arcade.roundIndex;
      tugWinsSeen = null;
      tinsOpenSeen = null;
      if (winTimer !== null) clearTimeout(winTimer);
      winTimer = null;
      winLog.hidden = true;
    }
    const said: (HTMLElement | null)[] = [];

    const t = arcade.tug;
    if (t) {
      // Off `wins` and not off the rope: the rope is a running difference
      // inside a pull, and the thing worth saying is the pull that closed. The
      // frame that carries the result is the one that starts the next pull, or
      // for the last pull the one that ends the round — so this reads the same
      // either way and the reveal frame is not a special case.
      //
      // A pull that ended level moves neither number and is announced as
      // nothing. There is no side to name, and the house does not narrate a
      // draw: *Elections achieve nothing* is the round's joke about itself and
      // it is already the reveal's headline.
      const seen = tugWinsSeen;
      if (seen !== null && (t.wins[0] > seen[0] || t.wins[1] > seen[1])) {
        const won: 0 | 1 = t.wins[0] > seen[0] ? 0 : 1;
        // No count line: the sentence names the side in words, which it has to
        // do on its own. The `PULLS WON A — B` tally is two lines above this
        // for every pull *except the last*, because the pull that ends a round
        // arrives on the frame that sets `idle`, and `idle` hides the rope
        // panel and its tally. A count line here would therefore be a number
        // with nothing to read it against exactly when it mattered most.
        said.push(winLine(HOUSE.tugPullWon(won), null));
      }
      tugWinsSeen = t.wins;
    }

    const u = arcade.unseal;
    if (u) {
      const now = new Map<string, number>(u.shapes.map((sh) => [sh.shape, sh.unsealed]));
      // Counts, and never people. `unsealOpened` — *Sealed: false.* — names
      // nobody, and the line under it is the shape's own counter, which is the
      // number already printed on that tile and has been all round. So this
      // beat carries no fact the panel was not carrying a frame earlier; it
      // only makes the moment legible from across the room.
      //
      // There is deliberately no `HOUSE.unsealOpen(n)` to reach for: "Player
      // 017 opened the tin", on a screen three metres from Player 017, is a
      // result the Lounge can bet on for a certainty, which is why the fastest
      // in a shape does not reach this surface before the reveal either — see
      // `arcadeUnsealFor`. `unsealOrder` is on this view and is not read here.
      //
      // Every open and not only a shape's first, which is the other half of
      // the same argument: the first tin in a shape *is* the +10 the server
      // withholds, and a beat that fired once per shape would be the screen
      // marking that moment out for the room. Every open is announced the same
      // way, so no one of them is flagged as the result.
      //
      // Running only. A tin opens when somebody finishes a word, which happens
      // while the round runs; a count that moves on the reveal frame is the
      // round being totted up, not a tin coming open, and *NOW OPEN* over the
      // words would be the screen narrating its own arithmetic.
      const seen = tinsOpenSeen;
      const opened =
        seen === null || arcade.phase !== "running"
          ? []
          : u.shapes.filter((sh) => sh.unsealed > (seen.get(sh.shape) ?? 0));
      if (opened.length > 0) {
        said.push(
          winLine(
            HOUSE.unsealOpened,
            `NOW OPEN · ${opened
              .map((sh) => {
                const face = UNSEAL_FACE[sh.shape];
                // The shape's name as well as its glyph: ○ and ☆ at this size
                // are two rings once the codec has had them, and the tiles are
                // the only other place the room can tell them apart.
                return `${face.glyph} ${face.name.toUpperCase()} ${sh.unsealed}/${sh.picked}`;
              })
              .join("  ·  ")}`,
          ),
        );
      }
      tinsOpenSeen = now;
    }

    if (said.length === 0) return;
    replace(winLog, said);
    winLog.hidden = false;
    if (winTimer !== null) clearTimeout(winTimer);
    // Four seconds, the dwell floor the drain keeps and for the same reason:
    // video latency is one to two seconds, so a thing shown for two was never
    // on the screen. A second tin inside the four re-arms the timer rather
    // than queueing behind it — the newer line is the one the room wants, and
    // a queue would leave the beat up for the rest of the round.
    winTimer = setTimeout(() => {
      winLog.hidden = true;
      winTimer = null;
    }, 4_000);
  };

  /**
   * The bridge: the room's shared picture, and the thing waves 2 and 3 are
   * legitimately reading.
   *
   * Six steps across, both pane labels in each, the pane that broke struck
   * through, and the player numbers standing on each step. Numbers and never
   * nicknames — DESIGN.md: "the nickname is on the phone only, where the
   * person it belongs to is the only reader."
   *
   * What is on this screen is what the whole room knows, which is why the
   * server treats it as the *only* public view of the round: this surface is
   * three metres from people who have not stepped yet. The pane that broke is
   * here only because the server does not send it until the step has closed.
   */
  const paintBridge = (state: RenderState, arcade: ArcadeView): void => {
    const g = arcade.glass;
    if (!g) {
      bridge.hidden = true;
      return;
    }
    bridge.hidden = false;
    const revealed = arcade.phase === "reveal";
    const { steps, across } = bridgeSteps(arcade, state.roster, g);

    // At the reveal the bridge has done its job and the room is reading the
    // answers, so the bridge row and the three waves step aside and the recap
    // takes the stage. Six steps, two notes each, squeezed under a bridge is
    // four steps nobody can read — which is the whole lesson of the round
    // going past at 1080p.
    bridgeRow.hidden = revealed;
    bridgeWaves.hidden = revealed;

    const left = remainingMs(g.stepEndsAt ?? null, serverNow());
    setText(
      bridgeClock,
      revealed
        ? "EIGHTEEN PANES. NINE ARE TEMPERED."
        : [
            `WAVE ${g.wave} OF 3`,
            `STEP ${(g.step ?? 0) + 1} OF ${g.of}`,
            `${g.waveSeconds[g.wave - 1] ?? 0}s A STEP`,
            left === null ? null : formatCountdown(left),
          ]
            .filter((x) => x !== null)
            .join(" · "),
    );

    replace(
      bridgeRow,
      [
        ...steps.map((step) =>
          h(
            "div",
            {
              class: "s-bridge-step",
              role: "listitem",
              attrs: {
                "data-open": step.open && !revealed ? "yes" : "no",
                "aria-label": `Step ${step.index + 1}${
                  step.broken === null
                    ? ""
                    : `, the ${step.broken === 0 ? "left" : "right"} pane broke`
                }${
                  step.standing.length === 0
                    ? ""
                    : `, ${step.standing.map((e) => playerName(e.playerNumber)).join(", ")} at this step`
                }`,
              },
            },
            [
              h("p", { class: "mono s-bridge-num", text: String(step.index + 1) }),
              h("p", { class: "s-bridge-product", text: step.product }),
              h(
                "div",
                { class: "s-bridge-panes" },
                [0, 1].map((side) =>
                  h("div", {
                    class: "s-bridge-pane",
                    attrs: { "data-broken": step.broken === side ? "yes" : "no" },
                  }, [
                    h("span", { class: "s-bridge-label", text: step.labels[side] ?? "" }),
                  ]),
                ),
              ),
              h(
                "div",
                { class: "mono s-bridge-who" },
                step.standing.map((e) =>
                  h("span", { class: "s-bridge-tag", text: e.tag }),
                ),
              ),
            ],
          ),
        ),
        h("div", { class: "s-bridge-far", role: "listitem" }, [
          h("p", { class: "s-bridge-far-mark", attrs: { "aria-hidden": "true" }, text: "▣" }),
          h("p", { class: "s-bridge-product", text: "THE FAR SIDE" }),
          h(
            "div",
            { class: "mono s-bridge-who" },
            across.map((e) => h("span", { class: "s-bridge-tag", text: e.tag })),
          ),
        ]),
      ],
    );

    // The three waves, which is how SPEC.md asks the room to read itself:
    // "by player number", with two cuts anybody can check against their own
    // badge. Wave 1 is labelled blind because that is what it is paid for.
    replace(
      bridgeWaves,
      waveRosters(arcade, state.roster, g).map((w) =>
        h(
          "div",
          {
            class: "s-wave",
            attrs: { "data-on": w.wave === g.wave && !revealed ? "yes" : "no" },
          },
          [
            h("p", { class: "mono s-wave-head" }, [
              h("span", { text: `WAVE ${w.wave}` }),
              h("span", { class: "s-wave-secs", text: `${w.seconds}s` }),
              w.wave === 1
                ? h("span", { class: "s-wave-blind", text: "BLIND" })
                : null,
            ]),
            h(
              "div",
              { class: "mono s-wave-tags" },
              w.members.map((e) =>
                h("span", {
                  class: "s-wave-tag",
                  text: e.tag,
                  attrs: {
                    "data-standing": e.standing,
                    "data-across": e.across ? "yes" : "no",
                    "data-away": e.away ? "yes" : "no",
                  },
                }),
              ),
            ),
          ],
        ),
      ),
    );

    // The reveal, which is the round's lesson and the only frame on which any
    // of this has existed. Both notes: the fake's is the joke and the real
    // one's is the thing somebody learns.
    const glassRecap = g.recap ?? [];
    bridgeRecap.hidden = glassRecap.length === 0;
    if (glassRecap.length > 0) {
      replace(
        bridgeRecap,
        glassRecap.map((step, i) =>
          h("li", { class: "s-bridge-recap-row" }, [
            h("span", { class: "mono s-bridge-recap-num", text: String(i + 1) }),
            h(
              "div",
              { class: "s-bridge-recap-panes" },
              [0, 1].map((side) =>
                h("div", {
                  class: "s-bridge-recap-pane",
                  attrs: { "data-real": step.real === side ? "yes" : "no" },
                }, [
                  h("span", {
                    class: "mono s-bridge-recap-mark",
                    attrs: { "aria-hidden": "true" },
                    text: step.real === side ? "○" : "□",
                  }),
                  h("span", { class: "s-bridge-recap-label", text: step.labels[side] ?? "" }),
                  h("span", { class: "s-bridge-recap-note", text: step.notes[side] ?? "" }),
                ]),
              ),
            ),
          ]),
        ),
      );
    }
  };

  /**
   * The four tins, filling up.
   *
   * Everything on this panel is a count or a player number: the words never
   * reach this surface until the reveal, and nor do the cues — a public list
   * of anagrams on a shared screen is somebody else's tin solved out loud by
   * whoever reads fastest. At the reveal the tiles step aside and the words
   * take the stage, both halves of each one: the answer, and the note, which
   * is the thing somebody actually learns.
   */
  const paintUnseal = (arcade: ArcadeView): void => {
    const u = arcade.unseal;
    if (!u) {
      unseal.hidden = true;
      return;
    }
    unseal.hidden = false;
    const revealed = arcade.phase === "reveal";
    const left = remainingMs(arcade.endsAt, serverNow());
    // The recap is read here as well as below because it is the only thing on
    // this view that knows how many tins were dealt, and the header counts
    // them rather than stating a number that a tenth tin can quietly falsify.
    const recap = u.recap ?? [];
    setText(
      unsealHead,
      revealed && recap.length > 0
        ? unsealRevealHead(recap.length)
        : [
            `${u.unsealed} OF ${u.picked} TINS OPEN`,
            arcade.phase === "card" ? "CHOOSING" : null,
            left === null ? null : formatCountdown(left),
          ]
            .filter((x) => x !== null)
            .join(" · "),
    );
    unsealTiles.hidden = revealed;
    replace(
      unsealTiles,
      u.shapes.map((sh) => {
        const face = UNSEAL_FACE[sh.shape];
        return h(
          "div",
          {
            class: "s-tin",
            role: "listitem",
            attrs: {
              "data-available": sh.available ? "yes" : "no",
              "aria-label": `${face.name}, worth ${sh.score}, ${sh.picked} chose it, ${sh.unsealed} open`,
            },
          },
          [
            h("p", {
              class: "s-tin-glyph",
              attrs: { "aria-hidden": "true" },
              text: face.glyph,
            }),
            h("p", { class: "mono s-tin-score", text: String(sh.score) }),
            h("p", { class: "display s-tin-count", text: `${sh.unsealed}/${sh.picked}` }),
            // The +10 board. A number, because the nickname is on the phone
            // only and this is the surface the whole room is reading.
            sh.fastest === undefined
              ? null
              : h("p", { class: "mono s-tin-fastest", text: playerTag(sh.fastest) }),
          ],
        );
      }),
    );
    // The +10 board: four glyphs and four player numbers, and only at the
    // reveal, because that is the first frame on which this surface has them.
    const fastest = u.shapes.filter((sh) => sh.fastest !== undefined);
    unsealFastest.hidden = fastest.length === 0;
    setText(
      unsealFastest,
      fastest.length === 0
        ? ""
        : `+10 · ${fastest
            .map((sh) => `${UNSEAL_FACE[sh.shape].glyph} ${playerTag(sh.fastest ?? 0)}`)
            .join("  ·  ")}`,
    );

    unsealRecap.hidden = recap.length === 0;
    if (recap.length > 0) {
      replace(
        unsealRecap,
        recap.map((tin) =>
          h("li", { class: "s-unseal-row" }, [
            h("span", {
              class: "s-unseal-shape",
              attrs: { "aria-hidden": "true" },
              text: UNSEAL_FACE[tin.shape].glyph,
            }),
            h("span", { class: "mono s-unseal-cue", text: tin.cue }),
            h("span", { class: "display s-unseal-answer", text: tin.answer }),
            h("span", { class: "s-unseal-note", text: tin.note }),
          ]),
        ),
      );
    }
  };

  /**
   * The rope, and the room's own heartbeat.
   *
   * The two clusters are player numbers, which is how the grid is labelled
   * everywhere else, and the rope's knot is the *share* of the on-beat taps
   * rather than their difference — a difference needs a scale and there is no
   * honest one that works for six people and for forty.
   */
  const paintTug = (state: RenderState, arcade: ArcadeView): void => {
    const t = arcade.tug;
    if (!t) {
      tug.hidden = true;
      return;
    }
    tug.hidden = false;
    const left = remainingMs(t.pullEndsAt ?? null, serverNow());
    setText(
      tugHead,
      arcade.phase === "reveal"
        ? "THREE PULLS. ONE ROPE."
        : [
            `PULL ${t.pull + 1} OF ${t.pulls}`,
            `${Math.round(60_000 / t.beatMs)} BPM`,
            left === null ? null : formatCountdown(left),
          ]
            .filter((x) => x !== null)
            .join(" · "),
    );

    const at = tugRope(t.totals);
    tugRopeTrack.style.setProperty("--at", `${at * 100}%`);
    tugRopeKnot.style.left = `${at * 100}%`;

    const entries = gridEntries(arcade, state.roster);
    const sides = t.sides ?? {};
    const leaders = t.leaders ?? [null, null];
    for (const [side, host] of [
      [0, tugSideA],
      [1, tugSideB],
    ] as const) {
      const members = entries.filter((e) => sides[e.pid] === side);
      replace(host, [
        h("p", { class: "mono s-cluster-head" }, [
          h("span", { text: side === 0 ? "SIDE A" : "SIDE B" }),
          h("span", { class: "s-cluster-n", text: String(t.totals[side]) }),
        ]),
        h(
          "div",
          { class: "mono s-cluster-tags" },
          members.map((e) =>
            h("span", {
              class: "s-cluster-tag",
              text: e.tag,
              attrs: {
                "data-away": e.away ? "yes" : "no",
                // The leader carries a mark as well as a hue, because nothing
                // on this surface may be told apart by colour alone.
                "data-leader": leaders[side] === e.playerNumber ? "yes" : "no",
              },
            }),
          ),
        ),
      ]);
    }
    setText(
      tugWins,
      `PULLS WON  A ${t.wins[0]} — B ${t.wins[1]}${
        leaders[0] === null && leaders[1] === null
          ? ""
          : `  ·  LEADERS ${leaders[0] === null ? "—" : playerTag(leaders[0])} / ${
              leaders[1] === null ? "—" : playerTag(leaders[1])
            }`
      }`,
    );
    paintTugPulse(arcade);
  };

  /**
   * The heartbeat itself, off the server's grid and nothing else.
   *
   * Called from the arcade ticker at 60 ms, which is a tenth of a 600 ms beat
   * — close enough that the snap lands where the beat does. A CSS keyframe
   * would be a second clock, started whenever this element happened to be
   * laid out, and the whole round is that there is only one.
   */
  const paintTugPulse = (arcade: ArcadeView): void => {
    const t = arcade.tug;
    if (!t || arcade.phase !== "running") {
      tugPulse.style.setProperty("--pulse", "0");
      return;
    }
    const beat = tugBeatAt(t, serverNow());
    if (beat === null) return;
    tugPulse.style.setProperty("--pulse", (1 - beat.phase).toFixed(3));
    setAttr(tugPulse, "data-on", beat.onBeat ? "yes" : "no");
  };

  /**
   * The ticker's rows, rebuilt only when the numbers on them changed.
   *
   * `paintLight` runs on every animation tick, because the wipe does — so
   * without this the corner of the screen would rebuild five list items forty
   * times a second to draw the same five numbers. The signature is the whole
   * of what is drawn, which is also why a tie broken on the player number in
   * `planApplyLeaders` matters here: two runners on 60 swapping places would
   * otherwise be a real change every frame.
   */
  let lastRunners = "";

  const paintRunners = (pa: NonNullable<ArcadeView["planApply"]>): void => {
    const leaders = pa.leaders ?? [];
    runnerBoard.hidden = leaders.length === 0;
    const signature = leaders.map((r) => `${r.playerNumber}/${r.resources}`).join(",");
    if (signature === lastRunners) return;
    lastRunners = signature;
    replace(
      runnerBoard,
      leaders.map((r) => {
        const fill = h("span", { class: "s-ticker-fill" });
        // Against the round's own target, not against the leader, so the bar
        // means "how much of the apply is done" — the same thing the phone's
        // progress bar means, and the number the checkpoint ticks sit on.
        fill.style.width =
          pa.target > 0
            ? `${Math.min(100, (r.resources / pa.target) * 100).toFixed(1)}%`
            : "0%";
        return h("li", { class: "s-ticker-row" }, [
          h("span", { class: "s-ticker-num", text: playerTag(r.playerNumber) }),
          h("span", { class: "s-ticker-bar", attrs: { "aria-hidden": "true" } }, [fill]),
          h("span", { class: "s-ticker-count", text: String(r.resources) }),
        ]);
      }),
    );
  };

  const paintLight = (arcade: ArcadeView): void => {
    const pa = arcade.planApply;
    if (!pa || arcade.phase !== "running") {
      light.hidden = true;
      lastRunners = "";
      return;
    }
    light.hidden = false;
    const face = LIGHT_FACE[pa.light];
    setText(sign, face.sign);
    setText(signGlyph, face.glyph);
    setAttr(light, "data-light", pa.light);
    light.style.setProperty("--light", face.fill);
    light.style.setProperty("--light-ink", face.on);
    setText(crossed, `${pa.crossed ?? 0} of ${arcade.onFloor + arcade.inLounge} across`);
    paintRunners(pa);

    // The wipe. Driven off the absolute epochs the server sent, never off a
    // duration measured from whenever this frame arrived — a screen that
    // received the frame 300 ms late must still finish the wipe at the
    // instant the lock actually lands.
    const f = wipeFraction(pa, serverNow());
    const turning = f !== null && f < 1;
    wipe.style.width = f === null ? "0%" : `${f * 100}%`;
    setClass(light, "is-turning", turning);
    // The head starts to turn with the wipe, which is the 400 ms of warning
    // the whole round depends on.
    dollWrap.style.setProperty("--turn", `${(f ?? (pa.light === "apply" ? 1 : 0)) * 180}deg`);
  };

  const paint = (state: RenderState): void => {
    const arcade = state.arcade;
    if (arcade === undefined) {
      setText(kicker, "Hashi Arcade");
      setText(title, "The next game will begin shortly.");
      replace(cardLines, []);
      replace(grid, []);
      bridge.hidden = true;
      unseal.hidden = true;
      tug.hidden = true;
      winLog.hidden = true;
      setText(counts, "");
      light.hidden = true;
      recap.hidden = true;
      bridge.hidden = true;
      grid.hidden = false;
      counts.hidden = false;
      stair.hidden = false;
      return;
    }

    const roundLabel = arcade.round ? ARCADE_ROUND_LABEL[arcade.round] : "Hashi Arcade";
    setText(kicker, roundLabel.toUpperCase());
    // The bridge is the round's own picture and it takes the space the
    // dormitory grid was using — it is never laid over the top of it. Between
    // rounds the grid comes straight back, which is where the host leaves it.
    const onBridge =
      arcade.round === "glass_bridge" &&
      (arcade.phase === "running" || arcade.phase === "reveal");
    // Unseal's tiles and Tug's rope take the space the grid was using in the
    // same way the bridge does, and give it back between rounds. Unseal's
    // picker is live against the round card, so its panel is up then too —
    // four tiles filling as the room chooses is what the card is *for*.
    const onTins =
      arcade.round === "unseal" && arcade.phase !== "idle";
    const onRope =
      arcade.round === "tug_of_raft" &&
      (arcade.phase === "running" || arcade.phase === "reveal");
    grid.hidden = onBridge || onTins || onRope;
    counts.hidden = grid.hidden;
    paintGrid(state, arcade);
    paintDrains(arcade);
    // Before the phase branches, like the drain, because the last pull of a
    // round is won on the frame that *ends* it and a branch that returned
    // early would eat the one result the round was about.
    //
    // Not, as this said, because that frame arrives as `phase: "reveal"`:
    // `endRound` in engine/reducer.ts sets `idle`, and `reveal` is a separate
    // thing the host does afterwards. The placement is right and the reason
    // given for it was wrong, which matters because the real phase is `idle`
    // — and `idle` hides the rope, so the last pull's beat lands on the
    // between-rounds screen with the `PULLS WON A — B` tally it refers to no
    // longer on it. The sentence still names the side in words, so it stands
    // on its own; see the note on the tally line.
    paintWinBeat(arcade);

    if (arcade.phase === "card" || arcade.phase === "idle") {
      stair.hidden = false;
      bridge.hidden = true;
      tug.hidden = true;
      // Unseal alone keeps its panel up against the round card, because the
      // card's own instruction — "Choose a shape. You will be given a sealed
      // tin" — is a control, and the room watching the four tiles fill is the
      // twenty seconds working rather than being waited out.
      if (arcade.round === "unseal" && arcade.phase === "card") paintUnseal(arcade);
      else unseal.hidden = true;
      // Between rounds the headline is always the next game, never a count of
      // who is left — DESIGN.md is explicit that the grid says that, quietly.
      const between = arcade.phase === "idle";
      setText(title, between ? "" : roundLabel);
      const lines = between
        ? [HOUSE.roundEnd]
        : arcade.round
          ? ARCADE_ROUND_CARD[arcade.round]
          : ARCADE_ROUND_CARD.recruitment;
      replace(
        cardLines,
        [
          ...lines.map((line) =>
            h("p", { class: "mono s-house" }, [
              h("span", { class: "s-prompt", attrs: { "aria-hidden": "true" }, text: ">" }),
              h("span", { text: line }),
            ]),
          ),
          // How to play, in the room's own language rather than the house's.
          // This is the only moment everybody is looking at the same screen
          // and nobody is under a timer, and none of them has played it before.
          ...(!between && arcade.round
            ? [
                h(
                  "div",
                  { class: "s-how" },
                  HOW_TO_PLAY[arcade.round].map((line) =>
                    h("p", { class: "s-how-line", text: line }),
                  ),
                ),
              ]
            : []),
          // The mask card, once, before Game 1.
          ...(!between && arcade.round === "plan_apply"
            ? [
                h(
                  "p",
                  { class: "mono s-staff" },
                  STAFF_CARD.map((l) => h("span", { class: "s-staff-line", text: l })),
                ),
              ]
            : []),
        ],
      );
      setText(cue, "");
      setText(recruitCount, "");
      recap.hidden = true;
      light.hidden = true;
      return;
    }

    stair.hidden = true;
    replace(cardLines, []);

    if (arcade.round === "unseal") {
      // SPEC.md's own framing for the round, and the answer to the question
      // everybody has been asking since the picker: the shapes were lengths.
      setText(
        title,
        arcade.phase === "reveal" ? "The shapes were word lengths." : "",
      );
      setText(cue, "");
      setText(recruitCount, "");
      recap.hidden = true;
      light.hidden = true;
      bridge.hidden = true;
      tug.hidden = true;
      paintUnseal(arcade);
      return;
    }
    unseal.hidden = true;

    if (arcade.round === "tug_of_raft") {
      setText(
        title,
        arcade.phase === "reveal" ? "Elections achieve nothing." : "",
      );
      setText(cue, "");
      setText(recruitCount, "");
      recap.hidden = true;
      light.hidden = true;
      bridge.hidden = true;
      paintTug(state, arcade);
      return;
    }
    tug.hidden = true;

    if (arcade.round === "glass_bridge") {
      // SPEC.md's own epigraph for the round, which is also the answer to
      // the question the room has been asking for three minutes.
      setText(
        title,
        arcade.phase === "reveal" ? "The tempered ones are real." : "",
      );
      setText(cue, "");
      setText(recruitCount, "");
      recap.hidden = true;
      light.hidden = true;
      paintBridge(state, arcade);
      return;
    }
    bridge.hidden = true;

    if (arcade.round === "plan_apply") {
      setText(title, "");
      setText(cue, "");
      setText(recruitCount, "");
      recap.hidden = arcade.phase !== "reveal";
      paintLight(arcade);
      if (arcade.phase === "reveal") {
        setText(title, HOUSE.roundEnd);
      }
      return;
    }

    light.hidden = true;
    const r = arcade.recruitment;
    if (!r) {
      setText(title, roundLabel);
      return;
    }
    if (arcade.phase === "reveal") {
      // SPEC.md: "At the end, the big screen 'recruits' everyone: the grid
      // fills with player numbers and the Front-End Man welcomes them." The
      // grid is already up; this is the welcome.
      setText(title, "Recruited.");
      setText(cue, "");
      setText(recruitCount, "");
      recap.hidden = (r.recap ?? []).length === 0;
      replace(
        recap,
        (r.recap ?? []).map((item) =>
          h("li", { class: "s-recap-row" }, [
            h("span", { class: "s-recap-cue", attrs: { "aria-hidden": "true" }, text: item.cue }),
            h("span", { class: "display s-recap-answer", text: item.answer }),
            h("span", { class: "s-recap-note", text: item.note }),
          ]),
        ),
      );
      return;
    }
    recap.hidden = true;
    setText(title, "");
    setText(cue, r.cue ?? "");
    setText(recruitCount, `${r.answered ?? 0} of ${r.eligible ?? 0} answered`);
  };

  ticker = setInterval(() => {
    // Only two things move without a frame arriving: the wipe, and the step's
    // countdown. Both are drawn off the absolute epochs the server sent.
    const a = lastState?.arcade;
    if (a?.round === "plan_apply" && a.phase === "running") paintLight(a);
    // The heartbeat, which is the one thing on this surface that has to move
    // in time with something. 60 ms is a tenth of a 600 ms beat.
    else if (a?.round === "tug_of_raft" && a.phase === "running") {
      paintTugPulse(a);
      const t = a.tug;
      const left = remainingMs(t?.pullEndsAt ?? null, serverNow());
      setText(
        tugHead,
        [
          `PULL ${(t?.pull ?? 0) + 1} OF ${t?.pulls ?? 0}`,
          `${Math.round(60_000 / (t?.beatMs ?? 600))} BPM`,
          left === null ? null : formatCountdown(left),
        ]
          .filter((x) => x !== null)
          .join(" · "),
      );
    } else if (a?.round === "unseal" && a.phase === "running") {
      const u = a.unseal;
      const left = remainingMs(a.endsAt, serverNow());
      setText(
        unsealHead,
        [
          `${u?.unsealed ?? 0} OF ${u?.picked ?? 0} TINS OPEN`,
          left === null ? null : formatCountdown(left),
        ]
          .filter((x) => x !== null)
          .join(" · "),
      );
    } else if (a?.round === "glass_bridge" && a.phase === "running" && lastState) {
      const g = a.glass;
      const left = remainingMs(g?.stepEndsAt ?? null, serverNow());
      setText(
        bridgeClock,
        [
          `WAVE ${g?.wave ?? 1} OF 3`,
          `STEP ${(g?.step ?? 0) + 1} OF ${g?.of ?? 0}`,
          `${g?.waveSeconds[(g?.wave ?? 1) - 1] ?? 0}s A STEP`,
          left === null ? null : formatCountdown(left),
        ]
          .filter((x) => x !== null)
          .join(" · "),
      );
    }
  }, ARCADE_TICK_MS);

  return {
    node,
    update(state) {
      lastState = state;
      paint(state);
    },
    stop() {
      if (ticker !== null) clearInterval(ticker);
      ticker = null;
      if (drainTimer !== null) clearTimeout(drainTimer);
      drainTimer = null;
      if (winTimer !== null) clearTimeout(winTimer);
      winTimer = null;
    },
  };
}

/**
 * Rank, name, total, and the contributions as one stacked bar in the activity
 * hues — the thing DESIGN.md asks the standings to keep from the live
 * scoreboard. A bar is readable at any resolution; the number is the bonus.
 *
 * Bench Credit is drawn hatched as well as dimmed, because nothing on this
 * surface may be conveyed by colour alone and a credited block is not the
 * same claim as a played one.
 */
function standingRow(
  row: StandingRow,
  top: number,
  activities: readonly ActivitySummary[],
): HTMLElement {
  const segments = stackedBar(row, activities, top);
  return h("li", { class: "s-row" }, [
    h("span", { class: "mono s-rank", text: String(row.rank) }),
    h("div", { class: "s-row-main" }, [
      h("span", { class: "display s-name-big", text: row.nickname }),
      h(
        "div",
        { class: "s-bar" },
        segments.map((seg) =>
          h("div", {
            class: seg.bench ? "s-seg s-seg-bench" : "s-seg",
            attrs: {
              style: `flex-basis:${seg.percent}%;background-color:${seg.hue}`,
              // Not read aloud anywhere, but it keeps the DOM honest about
              // what each block is when someone inspects a recording.
              "data-activity": seg.key,
            },
          }),
        ),
      ),
    ]),
    h("span", { class: "mono s-total", text: String(row.total) }),
  ]);
}

/** Which hue is which activity, in words. Three chips, ≥ 32px, no legend key. */
function activityLegend(activities: readonly ActivitySummary[]): HTMLElement[] {
  const chips = activities.map((a, i) =>
    h("span", { class: "s-legend-item" }, [
      h("span", {
        class: "s-legend-swatch",
        attrs: { style: `background:${activityHue(a, i)}`, "aria-hidden": "true" },
      }),
      h("span", { class: "s-legend-label", text: a.title }),
    ]),
  );
  chips.push(
    h("span", { class: "s-legend-item" }, [
      h("span", {
        class: "s-legend-swatch",
        attrs: { style: "background:var(--spot)", "aria-hidden": "true" },
      }),
      h("span", { class: "s-legend-label", text: "Spot Awards" }),
    ]),
  );
  return chips;
}

function sceneStandings(): Scene {
  const list = h("ol", { class: "s-rows" });
  const legend = h("div", { class: "s-legend" });
  const empty = h("p", { class: "s-line", text: "No scores yet." });
  const node = h("section", { class: "s-stage s-standings" }, [
    h("p", { class: "s-kicker label", text: "Standings · top five" }),
    list,
    legend,
    empty,
  ]);
  return {
    node,
    update(state) {
      // Exactly what arrived. The top five and the seal are the server's
      // rules; a screen that trimmed the list would be enforcing them twice.
      empty.hidden = state.standings.length > 0;
      legend.hidden = state.standings.length === 0;
      const top = state.standings[0]?.total ?? 0;
      replace(
        list,
        state.standings.map((row) => standingRow(row, top, state.activities)),
      );
      replace(legend, activityLegend(state.activities));
    },
  };
}

function sceneSealed(): Scene {
  // `SEALED_LINE`, not the holding card's second line, which is what this
  // read until a real room saw "Scores are hidden / By <a facilitator>" on
  // the wall. See `SEALED_LINE` for why that happens and why the fix is a
  // line of this screen's own.
  const node = h("section", { class: "s-stage s-sealed" }, [
    h("div", { class: "s-lock" }, [lockGlyph("s-lock-glyph")]),
    h("h1", { class: "display s-title s-title-huge", text: "Scores are hidden" }),
    h("p", { class: "s-line s-line-big", text: SEALED_LINE }),
  ]);
  return { node, update() {} };
}

/**
 * The final reveal: 5th, 4th, 3rd, 2nd — then a hold on an empty first slot
 * for longer than is comfortable — then the winner.
 *
 * Each step is a hard cut with a four-second dwell, because video latency is
 * one to two seconds and a thing that shows for two seconds was never seen.
 * The pace is local; the host pacing it with the space bar needs a message
 * this protocol does not have yet.
 *
 * The numbers live in shared/view.ts because the phone counts them too — it
 * holds its own rows back until this climb has landed — and a copy here is a
 * copy that drifts.
 */
function sceneFinal(): Scene {
  const list = h("ol", { class: "s-rows s-final-rows" });
  const winnerName = h("p", { class: "display s-winner-name" });
  const winnerTotal = h("p", { class: "mono s-winner-total" });
  const winnerBar = h("div", { class: "s-bar s-winner-bar" });
  const winner = h("div", { class: "s-winner", attrs: { hidden: true } }, [
    h("p", { class: "s-kicker label", text: "The winner" }),
    winnerName,
    winnerTotal,
    winnerBar,
  ]);
  const legend = h("div", { class: "s-legend" });
  const node = h("section", { class: "s-stage s-final" }, [
    h("p", { class: "s-kicker label", text: "Final standings" }),
    list,
    winner,
    legend,
  ]);

  let timers: ReturnType<typeof setTimeout>[] = [];
  let signature = "";

  const play = (
    rows: readonly StandingRow[],
    activities: readonly ActivitySummary[],
  ): void => {
    for (const t of timers) clearTimeout(t);
    timers = [];
    replace(list, []);
    winner.hidden = true;
    replace(legend, rows.length === 0 ? [] : activityLegend(activities));

    if (rows.length === 0) {
      replace(list, [h("p", { class: "s-line", text: "No scores were recorded." })]);
      return;
    }

    const top = rows[0]?.total ?? 0;
    // Bottom to top: 5th first, 1st last.
    const climb = [...rows].reverse().filter((r) => r.rank > 1);
    climb.forEach((row, i) => {
      timers.push(
        setTimeout(() => {
          list.insertBefore(standingRow(row, top, activities), list.firstChild);
        }, i * FINAL_DWELL_MS),
      );
    });
    const first = rows.find((r) => r.rank === 1);
    if (!first) return;
    timers.push(
      setTimeout(
        () => {
          setText(winnerName, first.nickname);
          setText(winnerTotal, String(first.total));
          // The winner gets the breakdown too: how they got there is the
          // thing the host talks over while it is on screen.
          replace(
            winnerBar,
            stackedBar(first, activities, top).map((seg) =>
              h("div", {
                class: seg.bench ? "s-seg s-seg-bench" : "s-seg",
                attrs: {
                  style: `flex-basis:${seg.percent}%;background-color:${seg.hue}`,
                  "data-activity": seg.key,
                },
              }),
            ),
          );
          winner.hidden = false;
        },
        finalRevealMs(rows),
      ),
    );
  };

  return {
    node,
    update(state) {
      // Replay only when the result actually changes, never on every broadcast.
      const sig = state.standings
        .map((r) => `${r.rank}:${r.nickname}:${r.total}:${JSON.stringify(r.perActivity)}:${r.spot}`)
        .join("|");
      if (sig === signature) return;
      signature = sig;
      play(state.standings, state.activities);
    },
    stop() {
      for (const t of timers) clearTimeout(t);
      timers = [];
    },
  };
}

/* ------------------------------------------------------------------ */
/* Toasts                                                              */
/* ------------------------------------------------------------------ */

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function showToast(kind: "spot" | "text", text: string): void {
  if (toastTimer !== null) clearTimeout(toastTimer);
  replace(toastBar, [
    kind === "spot" ? h("span", { class: "label s-toast-kind", text: "Spot Award" }) : null,
    h("span", { class: "s-toast-text", text }),
  ]);
  toastBar.hidden = false;
  toastBar.dataset["kind"] = kind;
  // Six seconds: comfortably past the four-second dwell floor.
  toastTimer = setTimeout(() => {
    toastBar.hidden = true;
  }, 6_000);
}

/* ------------------------------------------------------------------ */

/**
 * The top five and the seal are the server's rules. The screen renders what
 * arrives, so if more than five rows — or any row at all while sealed — ever
 * turn up, that is a bug to fix on the wire and not something to quietly
 * paper over here. Shout, render honestly.
 */
function guardPublic(state: RenderState): void {
  if (state.standings.length > 5) {
    console.error(
      `protocol violation: the screen received ${state.standings.length} standings rows; the wire must carry at most 5`,
    );
  }
  if (state.seal === "sealed" && state.standings.length > 0) {
    console.error(
      "protocol violation: standings arrived while sealed; sealed means no surface shows them",
    );
  }
  if (state.hostExtras !== undefined) {
    console.error("protocol violation: the screen received hostExtras");
  }
  // The room's screen is in the room. It learns the answer at the reveal and
  // not before, the same as every phone in front of it.
  if (state.trivia !== undefined && state.trivia.phase !== "revealed") {
    if (state.trivia.correct !== undefined) {
      console.error(
        "protocol violation: the screen received the correct answer before the reveal",
      );
    }
    if (state.trivia.distribution !== undefined) {
      console.error(
        "protocol violation: the screen received the distribution before the reveal",
      );
    }
  }
}

client = new QuorumClient({
  hello: () => ({ t: "hello", role: "screen", screenToken }),
  ...(mock ? { transport: mockTransport(mock) } : {}),

  onState(state) {
    guardPublic(state);
    render(state);
  },

  onStatus(status) {
    // Never a modal, and never anything about the network unless it is wrong.
    const bad = status === "reconnecting";
    banner.hidden = !bad;
    if (bad) setText(banner, "reconnecting");
  },

  onToast: showToast,

  onRefused(reason, message) {
    replace(stage, [
      h("section", { class: "s-stage s-card" }, [
        h("p", { class: "s-kicker label", text: "Quorum" }),
        h("h1", { class: "display s-title", text: "Refused" }),
        h("p", { class: "s-line", text: `${reason}: ${message}` }),
      ]),
    ]);
  },
});

client.start();
