// noVNC viewer inside the Remote Browser iframe (templates/remote_browser_screen.html).
// It lives in its own un-zoomed document so pointer coordinates are exact; the parent
// page drives it through window.rbScreen and gets events via parent.rbScreenEvent.
(() => {
    const NOVNC_CDN = 'https://cdn.jsdelivr.net/npm/@novnc/novnc@1.4.0/core/rfb.js';
    const NOVNC_LOCAL = '/api/remote-browser/novnc/core/rfb.js';
    const screen = document.getElementById('screen');
    let RFB = null;
    let rfb = null;

    // Viewer magnification on top of "fit to panel" (1 = fit). Larger values scroll.
    const ZOOM_STEPS = [1, 1.25, 1.5, 1.75, 2, 2.5, 3];
    let zoom = 1;

    const zoomLabel = () => (zoom === 1 ? 'Fit' : `${Math.round(zoom * 100)}%`);

    function applyZoom() {
        // noVNC has no public "scale by N"; its Display does (display.scale), and pointer
        // positions are computed from that same scale, so clicks stay exact.
        const display = rfb?._display;
        if (!rfb || !display || !display.width) return;
        if (zoom === 1) {
            rfb.scaleViewport = true;
            return;
        }
        rfb.scaleViewport = false;   // noVNC resets to 1:1 here, then we set our scale
        const fit = Math.min(screen.clientWidth / display.width, screen.clientHeight / display.height);
        display.scale = fit * zoom;
    }

    // noVNC re-scales on window resize; put our zoom back afterwards.
    window.addEventListener('resize', () => { if (zoom !== 1) setTimeout(applyZoom, 0); });

    const emit = (type, detail) => {
        try { window.parent.rbScreenEvent?.(type, detail); } catch (_) { /* parent gone */ }
    };

    async function loadRFB(local) {
        if (RFB) return RFB;
        try {
            RFB = (await import(local ? NOVNC_LOCAL : NOVNC_CDN)).default;
        } catch (e) {
            RFB = (await import(NOVNC_CDN)).default;  // distro copy failed - try the CDN
        }
        return RFB;
    }

    window.rbScreen = {
        get connected() { return rfb !== null; },

        async connect(novncLocal) {
            if (rfb) return true;
            let Client;
            try {
                Client = await loadRFB(novncLocal);
            } catch (e) {
                emit('loaderror', String(e));
                return false;
            }
            if (rfb) return true;
            screen.innerHTML = '';
            const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
            const client = new Client(screen, `${scheme}://${location.host}/api/remote-browser/ws`,
                                      { wsProtocols: ['binary'] });
            client.scaleViewport = true;
            client.resizeSession = false;
            client.focusOnClick = true;
            client.background = 'transparent';
            client.addEventListener('connect', () => {
                client.focus();
                setTimeout(applyZoom, 0);   // keep the zoom across reconnects
                emit('connect');
            });
            client.addEventListener('disconnect', e => {
                if (rfb === client) rfb = null;
                emit('disconnect', e.detail);
            });
            client.addEventListener('clipboard', e => emit('clipboard', e.detail.text));
            rfb = client;
            return true;
        },

        disconnect() {
            if (!rfb) return;
            const client = rfb;
            rfb = null;
            try { client.disconnect(); } catch (_) { /* already closed */ }
            screen.innerHTML = '';
        },

        paste(text) {
            if (!rfb) return false;
            rfb.clipboardPasteFrom(text);
            rfb.focus();
            return true;
        },

        focus() { rfb?.focus(); },

        // Magnify the viewer: 'in' / 'out' step through ZOOM_STEPS (times the fit-to-panel size),
        // 'fit' goes back to fitting the panel. Returns the label to show ('Fit', '150%').
        zoom(direction) {
            const i = ZOOM_STEPS.indexOf(zoom);
            if (direction === 'in') zoom = ZOOM_STEPS[Math.min(i + 1, ZOOM_STEPS.length - 1)];
            else if (direction === 'out') zoom = ZOOM_STEPS[Math.max(i - 1, 0)];
            else zoom = 1;
            applyZoom();
            rfb?.focus();
            return zoomLabel();
        },

        get zoomLabel() { return zoomLabel(); },

        toggleFullscreen() {
            if (document.fullscreenElement) document.exitFullscreen();
            else document.documentElement.requestFullscreen?.().then(() => rfb?.focus()).catch(() => {});
        },
    };

    emit('ready');
})();
