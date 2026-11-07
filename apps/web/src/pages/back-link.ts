export const BACK_LINK_SCRIPT = `(() => {
  const link = document.querySelector("a.back");
  if (!link) return;
  link.addEventListener("click", (e) => {
    if (history.length < 2 || !document.referrer) return;
    const from = new URL(document.referrer);
    if (from.origin !== location.origin || from.pathname.startsWith("/events/")) return;
    e.preventDefault();
    history.back();
  });
})();`;
