let __windowZIndex = 3000;

function bringToFront(el) {
    if (!el) return;
    __windowZIndex += 1;
    el.style.zIndex = String(__windowZIndex);
}

function registerWindowFocus(el, handles = []) {
    if (!el) return;
    const targets = handles.length ? handles : [el];
    targets.forEach(target => {
        target?.addEventListener('mousedown', () => bringToFront(el));
        target?.addEventListener('touchstart', () => bringToFront(el));
    });
}
