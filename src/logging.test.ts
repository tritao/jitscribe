import test from "node:test";
import assert from "node:assert/strict";
import { Logger } from "./logging.js";

test("logger accepts supported output modes", () => {
  assert.doesNotThrow(() => new Logger(false, "text"));
  assert.doesNotThrow(() => new Logger(true, "json"));
});
