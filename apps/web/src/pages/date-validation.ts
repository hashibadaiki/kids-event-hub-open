import { MAX_RANGE_DAYS } from "../search";

const MESSAGES = {
  bad: "日付を正しく入力してください",
  order: "「いつまで」は「いつから」と同じ日かそれより後にしてください",
  long: `期間は${MAX_RANGE_DAYS}日以内にしてください`,
};

export const DATE_VALIDATION_SCRIPT = `(() => {
  const m = ${JSON.stringify(MESSAGES)};
  const form = document.querySelector("form.filter");
  if (!form) return;
  const from = form.elements.namedItem("from");
  const to = form.elements.namedItem("to");
  const maxDays = Number(form.dataset.maxDays);
  const addDays = (d, n) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);
  const check = () => {
    const base = from.value || form.dataset.today;
    to.min = base;
    to.max = addDays(base, maxDays);
    from.setCustomValidity(from.validity.badInput ? m.bad : "");
    to.setCustomValidity("");
    if (to.validity.badInput) to.setCustomValidity(m.bad);
    else if (to.validity.rangeUnderflow) to.setCustomValidity(m.order);
    else if (to.validity.rangeOverflow) to.setCustomValidity(m.long);
  };
  from.addEventListener("input", check);
  to.addEventListener("input", check);
  check();
})();`;
