import test from "node:test";
import assert from "node:assert/strict";
import { isWide, SPLIT_MIN, MIN_LIST, MIN_CHAT, splitWidth, clampSplit, onDivider, dragTo, fold, filterTopics } from "../src/layout.mjs";

test("split threshold and default width", () => {
  assert.equal(SPLIT_MIN, 100);
  assert.equal(isWide(99), false); assert.equal(isWide(100), true);
  assert.equal(splitWidth(100), 30); // 30 %, within 24..40
  assert.equal(splitWidth(110), 33);
  assert.equal(splitWidth(200), 40); // capped
  assert.equal(splitWidth(80), 24);  // floor (only used when forced)
});

test("the divider can never squeeze either side below its minimum", () => {
  assert.equal(clampSplit(5, 120), MIN_LIST);
  assert.equal(clampSplit(500, 120), 120 - MIN_CHAT - 1);
  assert.equal(splitWidth(120, 500), 120 - MIN_CHAT - 1);
  assert.equal(splitWidth(120, "abc"), splitWidth(120)); // junk in config falls back to the default
  assert.equal(splitWidth(120, null), splitWidth(120));
  assert.equal(splitWidth(120, 50), 50);
});

test("grabbing and dragging the divider", () => {
  assert.equal(onDivider(33, 33), true); assert.equal(onDivider(35, 33), true);
  assert.equal(onDivider(32, 33), false); assert.equal(onDivider(36, 33), false);
  assert.equal(dragTo(51, 110), 50);     // divider ends up under the pointer
  assert.equal(dragTo(2, 110), MIN_LIST);
  assert.equal(dragTo(109, 110), 110 - MIN_CHAT - 1);
});

test("title filter folds case, diacritics and Turkish i", () => {
  assert.equal(fold("İSTANBUL"), "istanbul"); assert.equal(fold("Işık"), "isik"); assert.equal(fold("ışık"), "isik");
  assert.equal(fold("Toplantı ÇÖZÜM ğ"), "toplanti cozum g");
  const topics = [{ id: 1, title: "Release planning" }, { id: 2, title: "İstanbul toplantısı" }, { id: 3, title: "Incident notes", archived: true }, { id: 4, title: "Güvenlik" }];
  assert.deepEqual(filterTopics(topics, "istanbul").map((t) => t.id), [2]);
  assert.deepEqual(filterTopics(topics, "ISTANBUL TOPLANTI").map((t) => t.id), [2]);
  assert.deepEqual(filterTopics(topics, "guvenlik").map((t) => t.id), [4]);
  assert.deepEqual(filterTopics(topics, "notes planning").map((t) => t.id), []);   // every word must match
  assert.deepEqual(filterTopics(topics, "  ").map((t) => t.id), [1, 2, 3, 4]);    // empty keeps everything
  assert.deepEqual(filterTopics(topics, "incident").map((t) => t.id), [3]);        // archived still found
  // a private topic is searched by its decrypted title (the same `title` field the list shows)
  assert.deepEqual(filterTopics([{ id: 9, private: true, title: "Maaş görüşmesi" }], "maas").map((t) => t.id), [9]);
});
