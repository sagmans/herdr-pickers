// Pure interaction reducer between decoded input and picker view state.
// Async work is returned as effects so terminal-picker.ts keeps all I/O.
import type { PickerItem } from "./picker-row.ts";
import type { InputEvent } from "./terminal-picker-input.ts";
import {
  fitSelection,
  mouseAction,
  moveSelection,
  scrollRows,
  type PickerState,
  type Viewport,
} from "./terminal-picker-view.ts";

const DOUBLE_CLICK_MILLISECONDS = 400;
const WHEEL_STEP = 3;

/** Last row click; a second click on the same row inside the window accepts it. */
export interface ClickMemory {
  readonly itemId: string;
  readonly time: number;
}

/** Everything a key or mouse event may change synchronously. */
export interface InteractionState {
  readonly view: PickerState;
  readonly previousClick?: ClickMemory | undefined;
}

/**
 * Work the reducer cannot do itself: ranking, reloading, and handoff are
 * asynchronous and owned by the picker runner.
 */
export type InteractionEffect =
  | { readonly type: "none" }
  | { readonly type: "close" }
  | { readonly type: "accept"; readonly selection: PickerItem }
  | { readonly type: "query"; readonly query: string }
  | { readonly type: "reload" };

/** Inputs read from the outside world; `now` stays lazy so only clicks consult the clock. */
export interface InteractionContext {
  readonly viewport: Viewport;
  readonly now: () => number;
}

/** Next state plus the single effect the runner must perform for this event. */
export interface InteractionStep {
  readonly state: InteractionState;
  readonly effect: InteractionEffect;
}

const NONE: InteractionEffect = { type: "none" };

/**
 * Pure transition for one input event, kept apart from I/O so key and mouse
 * semantics can be reasoned about without the terminal loop.
 */
export function reduceInteraction(state: InteractionState, event: InputEvent, context: InteractionContext): InteractionStep {
  const { view } = state;
  switch (event.type) {
    case "close":
      return { state, effect: { type: "close" } };
    case "escape":
      // Escape clears a query before it dismisses, matching fzf muscle memory.
      return view.query.length === 0
        ? { state, effect: { type: "close" } }
        : { state, effect: { type: "query", query: "" } };
    case "accept": {
      const selection = view.items[view.selected];
      return { state, effect: selection === undefined ? NONE : { type: "accept", selection } };
    }
    case "up":
      return { state: { view: moveSelection(view, -1, context.viewport) }, effect: NONE };
    case "down":
      return { state: { view: moveSelection(view, 1, context.viewport) }, effect: NONE };
    case "backspace":
      return { state, effect: { type: "query", query: Array.from(view.query).slice(0, -1).join("") } };
    case "text":
      return { state, effect: { type: "query", query: view.query + event.value } };
    case "reload":
      return { state, effect: { type: "reload" } };
    case "mouse":
      return reduceMouse(state, event, context);
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

function reduceMouse(
  state: InteractionState,
  event: Extract<InputEvent, { readonly type: "mouse" }>,
  context: InteractionContext,
): InteractionStep {
  const { view, previousClick } = state;
  const action = mouseAction(event, view, context.viewport);
  switch (action.type) {
    case "close":
      return { state, effect: { type: "close" } };
    case "scroll":
      return { state: { view: scrollRows(view, action.delta * WHEEL_STEP, context.viewport) }, effect: NONE };
    case "select": {
      const clickedAt = context.now();
      const clickedItem = view.items[action.index];
      if (clickedItem !== undefined && previousClick?.itemId === clickedItem.id
        && clickedAt - previousClick.time <= DOUBLE_CLICK_MILLISECONDS) {
        return { state, effect: { type: "accept", selection: clickedItem } };
      }
      return {
        state: {
          view: fitSelection({ ...view, selected: action.index }, context.viewport),
          previousClick: clickedItem === undefined ? previousClick : { itemId: clickedItem.id, time: clickedAt },
        },
        effect: NONE,
      };
    }
    case "none":
      return { state, effect: NONE };
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}
