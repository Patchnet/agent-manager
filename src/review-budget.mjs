export const MAX_CORRECTIONS = 5;

export function reviewLimit(status) {
  return status.delivery?.review?.budget?.max_corrections ?? 1;
}

export function canCorrect(status, pass, now = Date.now()) {
  if (pass + (status.delivery?.review?.family?.consumedCorrections || 0) > reviewLimit(status)) return false;
  const review = status.delivery?.review;
  const seconds = review?.budget?.max_elapsed_sec;
  const first = review?.history?.find((item) => ["revise", "relaunch"].includes(item.verdict));
  const startedAt = review?.family?.startedAt || first?.decidedAt;
  return !seconds || !startedAt || now - Date.parse(startedAt) < seconds * 1000;
}

export function assertReviewPass(status, pass) {
  if (!Number.isInteger(pass) || pass < 1 || pass + (status.delivery?.review?.family?.consumedCorrections || 0) > reviewLimit(status) + 1) {
    throw new Error(`review pass must be 1 to ${reviewLimit(status) + 1}`);
  }
  if (pass > 1) {
    const previous = status.delivery?.review?.history?.find((item) => item.pass === pass - 1);
    if (!previous || !["revise", "relaunch"].includes(previous.verdict)) {
      throw new Error(`delivery review pass ${pass} requires a recorded pass ${pass - 1} correction decision`);
    }
  }
}

export function inheritCorrectionBudget(status, parent) {
  const review = parent?.delivery?.review;
  if (!review?.history?.length) return;
  const last = review.history.at(-1);
  if (!["revise", "relaunch"].includes(last.verdict)) return;
  const consumed = (review.family?.consumedCorrections || 0) + review.history.filter((item) => ["revise", "relaunch"].includes(item.verdict)).length;
  if (consumed > reviewLimit(parent)) throw new Error("parent correction budget exhausted");
  const startedAt = review.family?.startedAt || review.history.find((item) => ["revise", "relaunch"].includes(item.verdict)).decidedAt;
  if (review.budget?.max_elapsed_sec && Date.now() - Date.parse(startedAt) >= review.budget.max_elapsed_sec * 1000) throw new Error("parent correction elapsed-time budget exhausted");
  if (JSON.stringify([...(status.goalRefs || [])].sort()) !== JSON.stringify([...(parent.goalRefs || [])].sort())) throw new Error("correction must preserve parent goal references");
  status.delivery.review.budget = { max_corrections: reviewLimit(parent), ...(review.budget?.max_elapsed_sec ? { max_elapsed_sec: review.budget.max_elapsed_sec } : {}) };
  status.delivery.review.family = { rootRunId: review.family?.rootRunId || parent.runId, parentRunId: parent.runId,
    parentPass: last.pass, consumedCorrections: consumed,
    startedAt };
}
