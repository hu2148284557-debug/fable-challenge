import { LIMITS, NO_ACTION, unpackSession } from "./replay.js";

// "fable"：这一页加的对手 Fable 5.2。它和 Hybrid 走同一个入口，录像里每一帧都存着它出的动作。
const BOARDS = new Set(["hybrid", "laika", "killfield", "fable"]);

/** Parse a downloaded leaderboard record before it reaches the live engine. */
export async function parseReplayFile(text, stamps = null) {
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    throw new Error("The replay file is not valid JSON.");
  }
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("The replay file does not contain a record.");
  }
  if (!BOARDS.has(record.opponent)
      || !Number.isInteger(record.seed) || record.seed < 0 || record.seed > 0xffffffff
      || !Number.isInteger(record.delayFrames) || record.delayFrames < 0 || record.delayFrames > 3
      || !Number.isFinite(record.openingDelaySeconds)
      || record.openingDelaySeconds < 0 || record.openingDelaySeconds > 3
      || typeof record.track !== "string" || record.track.length > LIMITS.maxBase64) {
    throw new Error("The replay settings are invalid.");
  }
  if (stamps && (record.engine !== stamps.engine || record.policy !== stamps.policy)) {
    throw new Error("This replay was recorded with a different game build.");
  }
  const session = await unpackSession(record.track);
  if (session.frames.length === 0) throw new Error("The replay contains no frames.");
  const actionsMatch = record.opponent === "hybrid" || record.opponent === "fable"
    ? session.frames.every((frame) => frame.action !== NO_ACTION)
    : session.frames.every((frame) => frame.action === NO_ACTION);
  if (!actionsMatch) throw new Error("The replay opponent actions are invalid.");
  return { record, session };
}

export function replayClock(frame, total, fps = 25) {
  const clock = (value) => {
    const seconds = Math.floor(value / fps);
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
  };
  return `${clock(frame)} / ${clock(total)}`;
}
