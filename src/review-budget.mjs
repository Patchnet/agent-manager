export const MAX_CORRECTIONS = 5;

export function reviewLimit(status) {
  return status.delivery?.review?.budget?.max_corrections ?? 1;
}

export function canCorrect(status, pass, now = Date.now()) {
  if (pass > reviewLimit(status)) return false;
  const review = status.delivery?.review;
  const seconds = review?.budget?.max_elapsed_sec;
  const first = review?.history?.find((item) => ["revise", "relaunch"].includes(item.verdict));
  return !seconds || !first || now - Date.parse(first.decidedAt) < seconds * 1000;
}

export function assertReviewPass(status, pass) {
  if (!Number.isInteger(pass) || pass < 1 || pass > reviewLimit(status) + 1) {
    throw new Error(`review pass must be 1 to ${reviewLimit(status) + 1}`);
  }
  if (pass > 1) {
    const previous = status.delivery?.review?.history?.find((item) => item.pass === pass - 1);
    if (!previous || !["revise", "relaunch"].includes(previous.verdict)) {
      throw new Error(`delivery review pass ${pass} requires a recorded pass ${pass - 1} correction decision`);
    }
  }
}
