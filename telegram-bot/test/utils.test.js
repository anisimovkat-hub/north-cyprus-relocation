import test from "node:test";
import assert from "node:assert/strict";
import { isGuideKey, parseIdList, parseScheduleInput, topicTitle, validateGuide } from "../src/utils.js";

test("parseIdList accepts only numeric Telegram IDs", () => {
  assert.deepEqual([...parseIdList("123, -100456, @name, x")], ["123", "-100456"]);
});
test("guide keys are safe for Telegram deep links", () => {
  assert.equal(isGuideKey("guide_1"), true);
  assert.equal(isGuideKey("guide with spaces"), false);
  assert.equal(isGuideKey("я"), false);
});
test("schedule input is converted to UTC", () => {
  assert.equal(parseScheduleInput("2026-08-30 12:00", "+03:00"), "2026-08-30 09:00:00");
  assert.equal(parseScheduleInput("wrong", "+03:00"), null);
});
test("topic title preserves prefix and Telegram ID", () => {
  const value = topicTitle("ЗА", { id: 42, first_name: "А".repeat(200) });
  assert.equal(value.length, 128);
  assert.match(value, /^ЗА · /);
  assert.match(value, / #42$/);
});
test("guide validation requires a file and secure URLs", () => {
  assert.equal(validateGuide({ guide_key: "g1", title: "Гайд", document_file_id: "file" }), null);
  assert.match(validateGuide({ guide_key: "g1", title: "Гайд", document_url: "http://x.test" }), /HTTPS/);
});

