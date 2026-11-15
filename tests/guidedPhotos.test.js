// Guided before/after photos: which angles a job needs and what blocks completion.
import { test } from "node:test";
import assert from "node:assert/strict";
import { shotsForBooking, completionProblems, PHOTO_SHOTS, isShotKey, byShotOrder } from "../api/_jobs.js";

const keys = (shots) => shots.map((s) => s.key);
const INTERIOR = ["front_driver", "front_passenger", "center_console", "rear_driver", "rear_passenger", "third_driver", "third_passenger", "trunk"];
const EXTERIOR = ["ext_front", "ext_front_right", "ext_rear_left", "ext_wheel"];
const allPhotos = (kind, shots, except = []) =>
  shots.filter((s) => !s.optional && !except.includes(s.key)).map((s) => ({ kind, shot: s.key }));

test("shots follow the service: interior, exterior, both for combined/monthly, exterior for ceramic", () => {
  assert.deepEqual(keys(shotsForBooking({ category: "Interior Detail" })), INTERIOR);
  assert.deepEqual(keys(shotsForBooking({ category: "Exterior Detail" })), EXTERIOR);
  assert.deepEqual(keys(shotsForBooking({ category: "Combined Package" })), [...INTERIOR, ...EXTERIOR]);
  assert.deepEqual(keys(shotsForBooking({ category: "Monthly Detail" })), [...INTERIOR, ...EXTERIOR]);
  assert.deepEqual(keys(shotsForBooking({ category: "Interior Detail", jobFlag: "ceramic" })), [...INTERIOR, ...EXTERIOR]);
  assert.deepEqual(keys(shotsForBooking({ category: null })), [...INTERIOR, ...EXTERIOR]);
});

test("only the 3rd-row shots are optional, and every shot key is known", () => {
  assert.deepEqual(PHOTO_SHOTS.filter((s) => s.optional).map((s) => s.key), ["third_driver", "third_passenger"]);
  assert.ok(PHOTO_SHOTS.every((s) => isShotKey(s.key) && s.label && s.tip));
  assert.equal(isShotKey("selfie"), false);
});

test("every required angle needs a before and an after photo; optional ones don't block", () => {
  const shots = shotsForBooking({ category: "Interior Detail" });
  const before = allPhotos("before", shots);
  assert.deepEqual(completionProblems({ steps: [], shots, photos: [...before, ...allPhotos("after", shots)] }), []);

  const problems = completionProblems({ steps: [], shots, photos: [...before, ...allPhotos("after", shots, ["trunk", "front_driver"])] });
  assert.deepEqual(problems, ["After photos still needed: Front driver, Trunk"]);

  const none = completionProblems({ steps: [], shots, photos: [] });
  assert.equal(none.length, 2);
  assert.match(none[0], /^Before photos still needed: Front driver, Front passenger, Center console & screen, Back driver side, Back passenger side, Trunk$/);
});

test("a job with photos from before guided shots keeps the minimum-count rule for that kind", () => {
  const shots = shotsForBooking({ category: "Exterior Detail" });
  const legacyBefore = [{ kind: "before", shot: null }, { kind: "before", shot: null }];
  const problems = completionProblems({ steps: [], shots, photos: [...legacyBefore], mins: { before: 2, after: 4 } });
  assert.deepEqual(problems, ["After photos still needed: Front, straight on, Front ¾, passenger side, Rear ¾, driver side, Wheel"]);
  const short = completionProblems({ steps: [], shots, photos: [{ kind: "before", shot: null }, ...allPhotos("after", shots)], mins: { before: 2, after: 4 } });
  assert.deepEqual(short, ["1 more before photo needed (minimum 2)"]);
});

test("admin photo order follows the shooting order", () => {
  const sorted = [{ shot: "ext_wheel" }, { shot: null }, { shot: "front_driver" }, { shot: "trunk" }].sort(byShotOrder).map((p) => p.shot);
  assert.deepEqual(sorted, ["front_driver", "trunk", "ext_wheel", null]);
});
