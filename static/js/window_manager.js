let __windowZIndex = 3000;

function getPageZoom() {
    const value = getComputedStyle(document.documentElement).getPropertyValue('--page-zoom');
    const zoom = parseFloat(value);
    return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}

function getPointerPosition(e) {
    const zoom = getPageZoom();
    return {
        x: e.clientX / zoom,
        y: e.clientY / zoom,
    };
}

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
