/**
 * The participant page. Served at `/` and `/j/:code`.
 *
 * Two states and one transition: a join screen, then a page that follows the
 * host forever. There is no navigation after the join, by design — the host
 * decides what this shows, and a participant who can navigate is a participant
 * who can get lost while thirty people wait.
 */

import type { RenderState } from "../../protocol.ts";
import { h, qs, replace, setText } from "../shared/dom.ts";
import { QuorumClient, type Hello } from "../shared/net.ts";
import { mockBadge, mockTransport, readMockConfig } from "../shared/mock.ts";
import { refusalCopy } from "../shared/view.ts";
import { initTheme, themeToggle } from "../shared/theme.ts";
import { createParticipantView } from "./view.ts";

initTheme();

const STORE_KEY = "quorum.rejoin.v1";
const NICK_MAX = 24;

interface Stored {
  code: string;
  nickname: string;
  token: string;
}

function readStore(): Stored | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Stored>;
    if (typeof v.code !== "string" || typeof v.nickname !== "string") return null;
    if (typeof v.token !== "string") return null;
    return { code: v.code, nickname: v.nickname, token: v.token };
  } catch {
    return null;
  }
}

function writeStore(v: Stored | null): void {
  try {
    if (v === null) localStorage.removeItem(STORE_KEY);
    else localStorage.setItem(STORE_KEY, JSON.stringify(v));
  } catch {
    /* private browsing; the session still works, the rejoin just will not */
  }
}

/**
 * `/j/hvs.aB3…` → `hvs.aB3…`. The QR and the pasted link both land here.
 *
 * Never upper-cased: the code is base62 and `A` is not `a`. This folded case
 * while the codes were words, and leaving that in would have turned every
 * link into a code that does not exist.
 */
function codeFromPath(): string {
  const m = /^\/j\/(hvs\.[0-9A-Za-z]{8,64})\/?$/.exec(location.pathname);
  const fromQuery = new URLSearchParams(location.search).get("code");
  return (m?.[1] ?? fromQuery ?? "").trim();
}

function cleanNickname(raw: string): string {
  // Control characters out, whitespace collapsed. The server does this too;
  // doing it here means the person sees what they are actually joining as.
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NICK_MAX);
}

/* ------------------------------------------------------------------ */

const mock = readMockConfig();
const app = qs<HTMLElement>("#app");

let client: QuorumClient | null = null;

const view = createParticipantView({
  // The countdown is drawn from the absolute `closesAt` against the corrected
  // clock, never from a duration: see ARCHITECTURE.md "Clocks and fairness".
  now: () => client?.now() ?? Date.now(),
  onAnswer: (index, choice) => {
    client?.answer(index, choice);
  },
  onArcadeTap: (round) => {
    client?.arcadeTap(round);
  },
  onArcadeAnswer: (item, answer) => {
    client?.arcadeAnswer(item, answer);
  },
  onArcadeStep: (round, step, choice) => {
    client?.arcadeStep(round, step, choice);
  },
  onArcadeShape: (round, shape) => {
    client?.arcadeShape(round, shape);
  },
  onArcadeLetter: (round, letter) => {
    client?.arcadeLetter(round, letter);
  },
  onArcadeDocs: (round) => {
    client?.arcadeDocs(round);
  },
  onArcadeBeat: (round) => {
    client?.arcadeBeat(round);
  },
  onArcadeBack: (pid) => {
    client?.arcadeBack(pid);
  },
});
let nickname = "";
let joinCode = codeFromPath();
let rejoinToken: string | null = null;

const stored = readStore();
if (stored && (joinCode === "" || stored.code === joinCode)) {
  joinCode = stored.code;
  nickname = stored.nickname;
  rejoinToken = stored.token;
}

if (mock) document.body.appendChild(mockBadge());

if (rejoinToken !== null) {
  // The phone that slept, the tab that was closed, the switch to 4G. No
  // action from the person: they were already here.
  connect();
} else {
  showJoin(null);
}

/* ------------------------------------------------------------------ */
/* Join                                                                */
/* ------------------------------------------------------------------ */

function showJoin(error: { title: string; detail: string } | null): void {
  const prefilled = codeFromPath() !== "";

  const codeInput = h("input", {
    class: "field field-code field-token mono",
    id: "code",
    type: "text",
    value: joinCode,
    placeholder: "hvs.…",
    attrs: {
      maxlength: "72",
      autocapitalize: "off",
      autocorrect: "off",
      spellcheck: "false",
      inputmode: "text",
      "aria-label": "Join code",
    },
  });
  const nickInput = h("input", {
    class: "field field-nick",
    id: "nick",
    type: "text",
    value: nickname,
    placeholder: "Nickname",
    attrs: {
      maxlength: String(NICK_MAX),
      autocomplete: "off",
      autocorrect: "off",
      spellcheck: "false",
      enterkeyhint: "go",
      "aria-label": "Nickname",
    },
  });

  const errorBox = h("div", { class: "join-error", attrs: { role: "alert" } });
  if (error) {
    replace(errorBox, [
      h("strong", { text: error.title }),
      h("span", { text: error.detail }),
    ]);
  }

  const button = h("button", {
    class: "v-submit",
    type: "button",
    text: "Sign in",
  });

  const submit = (): void => {
    const code = codeInput.value.replace(/\s+/g, "");
    const nick = cleanNickname(nickInput.value);
    if (!/^hvs\.[0-9A-Za-z]{8,64}$/.test(code)) {
      return showJoin({
        title: "Join code needed",
        detail: "Paste the code the host posted in chat.",
      });
    }
    if (nick.length < 2) {
      return showJoin({
        title: "Nickname needed",
        detail: "Two characters or more, so the host can find you.",
      });
    }
    joinCode = code;
    nickname = nick;
    button.disabled = true;
    setText(button, "Joining…");
    connect();
  };

  button.addEventListener("click", submit);
  for (const field of [codeInput, nickInput]) {
    field.addEventListener("keydown", (ev) => {
      if ((ev as KeyboardEvent).key === "Enter") submit();
    });
  }
  // Paste, not type: strip whitespace a chat client may have wrapped in, and
  // never change case.
  codeInput.addEventListener("input", () => {
    codeInput.value = codeInput.value.replace(/\s+/g, "");
  });

  const codeRow = prefilled
    ? h("div", { class: "v-chip" }, [
        h("span", { class: "v-chip-label", text: "Join code" }),
        h("span", { class: "v-chip-value mono", text: joinCode }),
        h("button", {
          class: "v-linky",
          type: "button",
          text: "Change",
          on: {
            click: (ev) => {
              (ev.currentTarget as HTMLElement).parentElement?.replaceWith(
                codeField(),
              );
              codeInput.focus();
            },
          },
        }),
      ])
    : codeField();

  // Vault's Token field carries a reveal toggle; a pasted credential is worth
  // being able to check before submitting it.
  function codeField(): HTMLElement {
    const reveal = h("button", {
      class: "v-reveal",
      type: "button",
      text: "Show",
      attrs: { "aria-label": "Show the join code" },
    });
    reveal.addEventListener("click", () => {
      const masked = codeInput.classList.toggle("is-masked");
      setText(reveal, masked ? "Show" : "Hide");
      reveal.setAttribute(
        "aria-label",
        masked ? "Show the join code" : "Hide the join code",
      );
      codeInput.focus();
    });
    codeInput.classList.add("is-masked");
    return h("div", { class: "v-field" }, [
      h("label", { class: "v-label", text: "Join code" }),
      h("div", { class: "v-input-wrap" }, [codeInput, reveal]),
      h("p", { class: "v-help", text: "Starts with hvs." }),
    ]);
  }

  const methodField = h("div", { class: "v-field" }, [
    h("label", { class: "v-label", text: "Method" }),
    h(
      "select",
      { class: "v-select", attrs: { "aria-label": "Sign-in method" } },
      [h("option", { text: "Join code" })],
    ),
  ]);

  replace(app, [
    h("div", { class: "v-splash" }, [
      // Title above the card, aligned to its left edge.
      h("h1", { class: "v-title", text: "Sign in to Quorum" }),
      h("div", { class: "v-card" }, [
        errorBox,
        methodField,
        codeRow,
        h("div", { class: "v-field" }, [
          h("label", { class: "v-label", text: "Nickname" }),
          nickInput,
        ]),
        button,
      ]),
      h("div", { class: "v-splash-foot-row" }, [
        h("p", {
          class: "v-splash-foot",
          text: "Ask the host for the join code.",
        }),
        themeToggle(),
      ]),
    ]),
  ]);

  // Thumb reach: the join button is the one thing in the top third worth
  // tapping, so focus goes to the field that still needs an answer.
  (joinCode === "" ? codeInput : nickInput).focus();
}

function showTerminal(title: string, detail: string): void {
  replace(app, [
    h("div", { class: "terminal-card" }, [
      h("p", { class: "label", text: "Quorum" }),
      h("h1", { class: "display", text: title }),
      h("p", { class: "v-note", text: detail }),
    ]),
  ]);
}

/* ------------------------------------------------------------------ */
/* Connected                                                           */
/* ------------------------------------------------------------------ */

function connect(): void {
  client?.stop();

  const hello = (): Hello =>
    rejoinToken === null
      ? { t: "hello", role: "participant", joinCode, nickname }
      : { t: "hello", role: "participant", joinCode, nickname, rejoinToken };

  client = new QuorumClient({
    hello,
    ...(mock ? { transport: mockTransport(mock) } : {}),

    onWelcome(welcome) {
      if (welcome.rejoinToken !== undefined) {
        rejoinToken = welcome.rejoinToken;
        writeStore({ code: joinCode, nickname, token: welcome.rejoinToken });
      }
      if (app.firstElementChild !== view.root) replace(app, [view.root]);
    },

    onState(state) {
      guardTopFive(state);
      view.update(state, nickname);
    },

    onStatus(status) {
      // A banner, never a modal. The page underneath keeps its last state, so
      // nobody is ever looking at a blank screen while the socket comes back.
      view.setBanner(status === "reconnecting" ? "reconnecting…" : null);
    },

    onRefused(reason, message) {
      const copy = refusalCopy(reason, message, nickname);
      if (!copy.retry) {
        writeStore(null);
        rejoinToken = null;
        showTerminal(copy.title, copy.detail);
        return;
      }
      // A stale rejoin token is not the person's problem: drop it and ask.
      if (rejoinToken !== null) {
        writeStore(null);
        rejoinToken = null;
      }
      showJoin({ title: copy.title, detail: copy.detail });
    },

    onCommandResult(_cid, result) {
      // A refusal — the question closed a moment ago, the host advanced, the
      // step shut under the frame — has to take the optimistic state back off
      // the screen, or the person believes they did something they did not.
      //
      // Both are cleared on any refusal rather than matched to the frame that
      // caused it: only one of the two can be pending at a time (a phone is
      // either in trivia or on the bridge), and a `cid` table is a second
      // thing to keep in step for no gain.
      if (result.ok) return;
      view.clearPendingAnswer();
      view.clearPendingStep();
    },
  });

  client.start();
}

/**
 * The top-five rule is the server's to enforce, because the only way to keep
 * sixth place off a phone is to never send it. If a longer list ever arrives,
 * that is a bug in the server and not something to quietly paper over here.
 */
function guardTopFive(state: RenderState): void {
  if (state.standings.length > 5) {
    console.error(
      `protocol violation: participant received ${state.standings.length} standings rows; the wire must carry at most 5`,
    );
  }
  if (state.hostExtras !== undefined) {
    console.error("protocol violation: participant received hostExtras");
  }
  // The same rule, for the thing that is worth more than sixth place: while a
  // question is open the phone must not be able to learn whether it was
  // right. If any of this ever arrives early it is a bug on the wire, and the
  // console is where it gets shouted about rather than quietly rendered.
  const trivia = state.trivia;
  if (trivia !== undefined && trivia.phase !== "revealed") {
    if (trivia.correct !== undefined) {
      console.error(
        "protocol violation: participant received the correct answer before the reveal",
      );
    }
    if (state.triviaMine?.state === "revealed") {
      console.error(
        "protocol violation: participant received their result before the reveal",
      );
    }
  }
  if (trivia?.distribution !== undefined) {
    console.error("protocol violation: participant received the answer distribution");
  }

  // The arcade's version, and the one that matters most is the light
  // schedule: a phone holding `nextChangeAt` can tap flat out and stop
  // 401 ms before every lock. It is never sent, so if it turns up it is a
  // bug on the wire and this is where it gets shouted about.
  const arcade = state.arcade;
  if (arcade === undefined) return;
  const pa = arcade.planApply;
  if (pa?.nextChangeAt !== undefined || pa?.headTurnsAt !== undefined) {
    console.error(
      "protocol violation: participant received the light schedule; the lock must not be predictable from the phone",
    );
  }
  if (pa?.finishOrder !== undefined || pa?.crossed !== undefined) {
    console.error("protocol violation: participant received the Floor's results");
  }
  const r = arcade.recruitment;
  if (arcade.phase !== "reveal" && (r?.answer !== undefined || r?.recap !== undefined)) {
    console.error(
      "protocol violation: participant received a Recruitment answer before the reveal",
    );
  }
  if (r?.answered !== undefined || r?.eligible !== undefined) {
    console.error("protocol violation: participant received the room's answer counts");
  }

  // Unseal's version. The word is the round, so the two fields that would
  // give it away are the recap — which carries every answer — and any cue but
  // this phone's own, which arrives on `arcadeMine` and nowhere else. A
  // public list of cues would be nine anagrams on a shared screen, which is
  // somebody else's tin solved out loud.
  const u = arcade.unseal;
  if (u !== undefined) {
    if (arcade.phase !== "reveal" && u.recap !== undefined) {
      console.error(
        "protocol violation: participant received the Unseal answers before the reveal",
      );
    }
    if (u.progress !== undefined || u.docs !== undefined) {
      console.error("protocol violation: participant received the room's Unseal detail");
    }
    if (u.unsealOrder !== undefined || u.shapes.some((sh) => sh.fastest !== undefined)) {
      console.error("protocol violation: participant received the Floor's results");
    }
  }

  // Tug of Raft has no answer to leak — nobody drains and there is nothing to
  // know — but the rule about *what another player did* still holds, and the
  // per-player beat counts are exactly that.
  const t = arcade.tug;
  if (t !== undefined) {
    if (t.sides !== undefined || t.leaders !== undefined || t.onBeats !== undefined) {
      console.error(
        "protocol violation: participant received the room's Tug of Raft detail",
      );
    }
  }

  // The Glass Bridge's version, and it is the loudest one in this function
  // because it is the only round whose answer is worth something to the
  // person sitting next to you. `recap` carries `real` and both reveal notes;
  // a phone that has it while the bridge is being crossed knows every pane,
  // and so does anybody who can see that phone.
  const g = arcade.glass;
  if (g === undefined) return;
  if (arcade.phase !== "reveal" && g.recap !== undefined) {
    console.error(
      "protocol violation: participant received the bridge's answer key before the reveal",
    );
  }
  if (g.crossed !== undefined || g.fastest !== undefined || g.elapsedMs !== undefined) {
    console.error("protocol violation: participant received the Floor's results");
  }
  if (arcade.phase === "card" && g.board !== undefined) {
    console.error(
      "protocol violation: participant received the panes while the round card was up",
    );
  }
}
