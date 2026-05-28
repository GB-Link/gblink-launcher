const GBLINK_USB_FILTERS = [
    { vendorId: 0x239a },
    { vendorId: 0xcafe },
    { vendorId: 0x2fe3 },
];

const GBL_CMD_GET_FIRMWARE_INFO = 0x0f;
const WEBUSB_VENDOR_REQUEST = 0x01;
const WEBUSB_LANDING_PAGE_INDEX = 0x01;

const GBLINK_VENDOR_ID = 0x2fe3;
const TINYUSB_VENDOR_ID = 0xcafe;
const ADAFRUIT_VENDOR_ID = 0x239a;
const GB_LINK_PRODUCT_HINT = 'game boy link';
const STARLARKUS_RECONFIGURABLE_MIN_VERSION = '1.0.6';

const RECONFIGURABLE_PROBE_PREFIX = new Uint8Array([
    0xca, 0xfe, 0xca, 0xfe, 0xca, 0xfe, 0xca, 0xfe,
    0xca, 0xfe, 0xca, 0xfe, 0xca, 0xfe, 0xca, 0xfe,
    0xde, 0xad, 0xbe, 0xef, 0xde, 0xad, 0xbe, 0xef,
    0xde, 0xad, 0xbe, 0xef, 0xde, 0xad, 0xbe, 0xef,
    0x00, 0x00, 0x00, 0x00,
]);

const STARLARKUS_LED_PROBE = new Uint8Array([
    0xca, 0xfe, 0xca, 0xfe, 0xca, 0xfe, 0xca, 0xfe,
    0xca, 0xfe, 0xca, 0xfe, 0xca, 0xfe, 0xca, 0xfe,
    0xde, 0xad, 0xbe, 0xef, 0xde, 0xad, 0xbe, 0xef,
    0xde, 0xad, 0xbe, 0xef, 0xde, 0xad, 0xbe, 0xef,
    0x4c, 0x45, 0x44, 0x53,
    0x00, 0x00, 0x00, 0x00,
]);

const STORAGE_KEY_GAME = 'gblink-launcher-game';
const STORAGE_KEY_AUTO_REDIRECT = 'gblink-launcher-auto-redirect';
const REDIRECT_DELAY_SECONDS = 5;
const LAUNCHER_QUERY_KEY = 'from';
const LAUNCHER_QUERY_VALUE = 'gblink-launcher';

let firmwareCatalogPromise = null;

function formatVersion(major, minor, patch) {
    return `v${major}.${minor}.${patch}`;
}

function normalizeKnownGblinkVersion(version) {
    // Upstream release v2.0.1 reports itself as 2.0.0 over 0x0F firmware info.
    if (version === '2.0.0') return '2.0.1';
    return version;
}

function formatKnownGblinkVersionLabel(version) {
    if (!version) return 'GBLink';
    if (version === '2.0.2') return 'GBLink v2.0.2 or v2.0.3';
    return `GBLink v${version}`;
}

function parseVersion(version) {
    if (!version) return null;
    const match = String(version).replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)$/);
    if (!match) return null;
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
    };
}

function compareVersions(a, b) {
    const left = parseVersion(a);
    const right = parseVersion(b);
    if (!left || !right) return 0;
    if (left.major !== right.major) return left.major < right.major ? -1 : 1;
    if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
    if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;
    return 0;
}

function stripVersionPrefix(versionLabel) {
    if (!versionLabel) return null;
    const match = versionLabel.match(/v?(\d+\.\d+\.\d+)/i);
    return match ? match[1] : null;
}

function loadFirmwareCatalog() {
    if (!firmwareCatalogPromise) {
        firmwareCatalogPromise = fetch('data/firmware.json')
            .then(res => {
                if (!res.ok) throw new Error(`Failed to load firmware.json (${res.status})`);
                return res.json();
            })
            .catch(err => {
                console.warn('Could not load firmware catalog:', err);
                return null;
            });
    }
    return firmwareCatalogPromise;
}

function getFirmwareUpdateInfo(entry, deviceVersion) {
    if (!entry?.latest || !deviceVersion) return null;
    if (compareVersions(deviceVersion, entry.latest) >= 0) return null;

    const release = entry.releases?.find(r => r.version === entry.latest);
    return {
        latest: entry.latest,
        uf2: release?.uf2 ?? entry.releases?.[0]?.uf2,
        name: release?.name,
    };
}

function getFirmwareRelease(catalog, family, version) {
    const release = catalog?.[family]?.releases?.find(r => r.version === version);
    if (!release?.uf2) return null;
    return {
        latest: version,
        uf2: release.uf2,
        name: release.name,
    };
}

function resolveFirmwareUpdate(catalog, firmwareInfo) {
    const entry = catalog?.[firmwareInfo.family];
    if (!entry) return null;

    if (entry.upgradeTo) {
        const { family, version } = entry.upgradeTo;
        return getFirmwareRelease(catalog, family, version);
    }

    if (!firmwareInfo.version) return null;
    return getFirmwareUpdateInfo(entry, firmwareInfo.version);
}

function descriptorVersionString(device) {
    const major = device.deviceVersionMajor ?? 0;
    const minor = device.deviceVersionMinor ?? 0;
    const patch = device.deviceVersionSubminor ?? 0;
    if (major === 0 && minor === 0 && patch === 0) return null;
    return `${major}.${minor}.${patch}`;
}

function isStarlarkusReconfigurableByVersion(device) {
    const version = descriptorVersionString(device);
    return version != null && compareVersions(version, STARLARKUS_RECONFIGURABLE_MIN_VERSION) >= 0;
}

function isTinyUsbFirmware(device) {
    if (device.vendorId === TINYUSB_VENDOR_ID) return true;
    if (device.vendorId !== ADAFRUIT_VENDOR_ID) return false;
    const product = (device.productName || '').toLowerCase();
    return product.includes(GB_LINK_PRODUCT_HINT) || product.includes('gblink');
}

function classifyTinyUsbUrl(url) {
    const lower = url.toLowerCase();
    if (lower.includes('stacksmashing')) return 'original';
    if (lower.includes('starlarkus')) return 'reconfigurable-starlarkus';
    if (lower.includes('lorenzooone')) return 'reconfigurable-lorenzooone';
    if (lower.includes('gblink.io')) return 'reconfigurable';
    return null;
}

function findVendorInterface(device) {
    const config = device.configuration;
    if (!config) return null;

    for (const iface of config.interfaces) {
        for (const alt of iface.alternates) {
            if (alt.interfaceClass !== 0xff) continue;

            const inEps = alt.endpoints
                .filter(ep => ep.direction === 'in')
                .sort((a, b) => a.endpointNumber - b.endpointNumber);
            const outEps = alt.endpoints
                .filter(ep => ep.direction === 'out')
                .sort((a, b) => a.endpointNumber - b.endpointNumber);

            if (outEps.length === 0 || inEps.length === 0) continue;

            const isGblink = device.vendorId === GBLINK_VENDOR_ID;
            return {
                interfaceNumber: iface.interfaceNumber,
                cmdEpOut: isGblink && outEps.length >= 2
                    ? outEps[0].endpointNumber
                    : outEps[outEps.length - 1].endpointNumber,
                dataEpOut: outEps[outEps.length - 1].endpointNumber,
                dataEpIn: inEps[inEps.length - 1].endpointNumber,
                isGblink,
                isTinyUsb: isTinyUsbFirmware(device),
            };
        }
    }
    return null;
}

async function transferInWithTimeout(device, endpoint, length, ms) {
    return Promise.race([
        device.transferIn(endpoint, length),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
    ]);
}

async function enableTinyUsbWebSerial(device, interfaceNumber) {
    await device.controlTransferOut({
        requestType: 'class',
        recipient: 'interface',
        request: 0x22,
        value: 0x01,
        index: interfaceNumber,
    });
}

async function queryWebUsbLandingUrl(device, interfaceNumber) {
    const result = await device.controlTransferIn({
        requestType: 'vendor',
        recipient: 'interface',
        request: WEBUSB_VENDOR_REQUEST,
        value: WEBUSB_LANDING_PAGE_INDEX,
        index: interfaceNumber,
    }, 64);

    const raw = result.data ? new Uint8Array(result.data.buffer) : new Uint8Array();
    if (raw.length < 4) return null;

    const scheme = raw[2] === 1 ? 'https://' : 'http://';
    const host = new TextDecoder().decode(raw.subarray(3)).replace(/\0/g, '').trim();
    return host ? scheme + host : null;
}

async function probeTinyUsbAck(device, iface, packet, expectedByte) {
    await enableTinyUsbWebSerial(device, iface.interfaceNumber);
    await device.transferOut(iface.dataEpOut, packet);

    try {
        const result = await transferInWithTimeout(device, iface.dataEpIn, 8, 300);
        const data = result.data ? new Uint8Array(result.data.buffer) : new Uint8Array();
        return data.length > 0 && data[0] === expectedByte;
    } catch {
        return false;
    }
}

async function probeReconfigurableProtocol(device, iface) {
    return probeTinyUsbAck(device, iface, RECONFIGURABLE_PROBE_PREFIX, 0x01);
}

async function probeStarlarkusLedProtocol(device, iface) {
    return probeTinyUsbAck(device, iface, STARLARKUS_LED_PROBE, 0x4c);
}

async function queryGblinkFirmwareVersion(device, iface) {
    await device.transferOut(iface.cmdEpOut, new Uint8Array([GBL_CMD_GET_FIRMWARE_INFO]));

    const result = await transferInWithTimeout(device, iface.dataEpIn, 64, 500);
    const data = result.data ? new Uint8Array(result.data.buffer) : new Uint8Array();

    if (data.length >= 4 && data[0] === GBL_CMD_GET_FIRMWARE_INFO) {
        return formatVersion(data[1], data[2], data[3]);
    }
    return null;
}

async function detectGblinkFirmware(device, iface) {
    let version = null;

    try {
        const reported = await queryGblinkFirmwareVersion(device, iface);
        version = normalizeKnownGblinkVersion(stripVersionPrefix(reported));
    } catch {}

    return {
        family: 'gblink',
        label: formatKnownGblinkVersionLabel(version),
        version,
    };
}

function buildStarlarkusReconfigurableLabel(device) {
    const version = descriptorVersionString(device);
    return {
        family: 'reconfigurable-starlarkus',
        label: `Reconfigurable (Starlarkus) v${version}`,
        version,
    };
}

function buildLorenzoooneReconfigurableLabel(device) {
    const version = descriptorVersionString(device);
    return {
        family: 'reconfigurable-lorenzooone',
        label: version ? `Reconfigurable (Lorenzooone) v${version}` : 'Reconfigurable (Lorenzooone)',
        version,
    };
}

async function detectTinyUsbFirmware(device, iface) {
    let kind = null;

    try {
        const url = await queryWebUsbLandingUrl(device, iface.interfaceNumber);
        if (url) kind = classifyTinyUsbUrl(url);
    } catch {}

    if (kind === 'reconfigurable-lorenzooone') {
        return buildLorenzoooneReconfigurableLabel(device);
    }

    if (!kind) {
        try {
            kind = await probeReconfigurableProtocol(device, iface) ? 'reconfigurable' : 'original';
        } catch {
            kind = 'original';
        }
    }

    if (kind === 'reconfigurable' || kind === 'reconfigurable-starlarkus') {
        if (isStarlarkusReconfigurableByVersion(device)) {
            return buildStarlarkusReconfigurableLabel(device);
        }

        try {
            if (await probeStarlarkusLedProtocol(device, iface)) {
                return buildStarlarkusReconfigurableLabel(device);
            }
        } catch {}

        return buildLorenzoooneReconfigurableLabel(device);
    }

    return {
        family: kind || 'unknown',
        label: kind === 'original' ? 'Original' : 'Unknown',
        version: null,
    };
}

async function detectFirmware(device, iface) {
    if (iface.isGblink) return detectGblinkFirmware(device, iface);
    if (iface.isTinyUsb) return detectTinyUsbFirmware(device, iface);
    return { family: 'unknown', label: 'Unknown', version: null };
}

function formatUsbId(device) {
    const vid = device.vendorId.toString(16).padStart(4, '0');
    const pid = device.productId.toString(16).padStart(4, '0');
    return `${vid}:${pid}`;
}

function createDeviceHealth({
    disconnectedEl,
    connectedEl,
    connectBtn,
    disconnectBtn,
    statusEl,
    firmwareEl,
    firmwareCopiedEl,
    usbIdEl,
    updateEl,
    updateVersionEl,
    updateLinkEl,
}) {
    let activeDevice = null;
    let connecting = false;
    let firmwareCopiedTimeout = null;
    const firmwareCatalog = loadFirmwareCatalog();

    async function copyFirmwareLabel() {
        if (!firmwareEl) return;
        const text = firmwareEl.textContent?.trim();
        if (!text) return;

        try {
            await navigator.clipboard.writeText(text);
        } catch {
            const area = document.createElement('textarea');
            area.value = text;
            area.setAttribute('readonly', '');
            area.style.position = 'fixed';
            area.style.left = '-9999px';
            document.body.appendChild(area);
            area.select();
            document.execCommand('copy');
            document.body.removeChild(area);
        }

        if (firmwareCopiedEl) {
            firmwareCopiedEl.hidden = false;
            if (firmwareCopiedTimeout) clearTimeout(firmwareCopiedTimeout);
            firmwareCopiedTimeout = setTimeout(() => {
                firmwareCopiedEl.hidden = true;
            }, 2000);
        }
    }

    firmwareEl?.addEventListener('click', () => copyFirmwareLabel());

    function setConnected(connected) {
        disconnectedEl.hidden = connected;
        connectedEl.hidden = !connected;
    }

    function setField(el, text) {
        if (el) el.textContent = text;
    }

    function setUpdateNotice(update) {
        if (!updateEl) return;

        if (!update) {
            updateEl.hidden = true;
            return;
        }

        if (updateVersionEl) {
            updateVersionEl.textContent = `v${update.latest}`;
        }
        if (updateLinkEl) {
            updateLinkEl.href = update.uf2 || '#';
            updateLinkEl.download = update.uf2
                ? update.uf2.split('/').pop()
                : '';
        }
        updateEl.hidden = false;
    }

    async function updatePanel(device, firmwareInfo) {
        setField(statusEl, 'Connected');
        statusEl?.classList.remove('status-disconnected');
        statusEl?.classList.add('status-connected');

        setField(firmwareEl, firmwareInfo.label);
        setField(usbIdEl, formatUsbId(device));

        const catalog = await firmwareCatalog;
        const update = resolveFirmwareUpdate(catalog, firmwareInfo);
        setUpdateNotice(update);
        setConnected(true);
    }

    function resetPanel() {
        setField(statusEl, 'Disconnected');
        statusEl?.classList.remove('status-connected');
        statusEl?.classList.add('status-disconnected');
        setUpdateNotice(null);
        setConnected(false);
        activeDevice = null;
    }

    async function openDevice(device) {
        if (device.opened) await device.close();
        await device.open();
        if (device.reset) {
            await device.reset().catch(() => {});
        }
        await device.selectConfiguration(1);
        return findVendorInterface(device);
    }

    async function connect(existingDevice = null) {
        if (connecting) return;
        if (!navigator.usb) {
            window.alert('WebUSB is not supported in this browser. Use Chrome or Edge to connect your adapter.');
            return;
        }

        connecting = true;
        connectBtn.disabled = true;

        let device = null;
        try {
            device = existingDevice ?? await navigator.usb.requestDevice({ filters: GBLINK_USB_FILTERS });
            const iface = await openDevice(device);
            if (!iface) throw new Error('No compatible GB Link interface found');

            await device.claimInterface(iface.interfaceNumber);
            await device.selectAlternateInterface(iface.interfaceNumber, 0);

            const firmwareInfo = await detectFirmware(device, iface);
            activeDevice = device;
            await updatePanel(device, firmwareInfo);
        } catch (err) {
            if (device?.opened) {
                await device.close().catch(() => {});
            }
            if (err?.name !== 'NotFoundError') {
                console.error('Device connect failed:', err);
            }
            resetPanel();
        } finally {
            connecting = false;
            connectBtn.disabled = false;
        }
    }

    async function disconnect() {
        if (activeDevice?.opened) {
            try {
                await activeDevice.close();
            } catch (err) {
                console.warn('Device close failed:', err);
            }
        }
        resetPanel();
    }

    connectBtn.addEventListener('click', () => connect());
    disconnectBtn.addEventListener('click', () => disconnect());

    if (navigator.usb) {
        navigator.usb.addEventListener('disconnect', event => {
            if (activeDevice && event.device === activeDevice) {
                resetPanel();
            }
        });

        navigator.usb.getDevices().then(devices => {
            const known = devices.find(d =>
                GBLINK_USB_FILTERS.some(f => f.vendorId === d.vendorId));
            if (known) connect(known);
        });
    }

    return { connect, disconnect, resetPanel };
}

function initDeviceHealthPanel() {
    createDeviceHealth({
        disconnectedEl: document.getElementById('device-disconnected'),
        connectedEl: document.getElementById('device-connected'),
        connectBtn: document.getElementById('device-connect'),
        disconnectBtn: document.getElementById('device-disconnect'),
        statusEl: document.getElementById('device-status'),
        firmwareEl: document.getElementById('device-firmware'),
        firmwareCopiedEl: document.getElementById('device-firmware-copied'),
        usbIdEl: document.getElementById('device-usb-id'),
        updateEl: document.getElementById('device-update'),
        updateVersionEl: document.getElementById('device-update-version'),
        updateLinkEl: document.getElementById('device-update-link'),
    });
}

function initBrowserInfo() {
    const webusbEl = document.getElementById('browser-webusb');
    const browserEl = document.getElementById('browser-name');
    if (!webusbEl || !browserEl) return;

    const webUsbAvailable = Boolean(navigator.usb);
    webusbEl.textContent = webUsbAvailable ? 'Available' : 'Not available';
    webusbEl.classList.add(webUsbAvailable ? 'browser-webusb--ok' : 'browser-webusb--no');

    const ua = navigator.userAgent;

    function getBrowserNameFromBrands() {
        const brands = navigator.userAgentData?.brands;
        if (!brands?.length) return null;

        const preferredOrder = [
            'Microsoft Edge',
            'Google Chrome',
            'Opera',
            'Brave',
            'Vivaldi',
        ];

        for (const label of preferredOrder) {
            if (brands.some(brand => brand.brand === label)) return label;
        }

        const fallback = brands.find(
            brand => !/not.?a?.brand|chromium/i.test(brand.brand)
        );
        return fallback?.brand ?? null;
    }

    let browserName = 'Unknown browser';
    if (/Edg\//.test(ua)) {
        browserName = 'Microsoft Edge';
    } else if (/OPR\/|Opera/.test(ua)) {
        browserName = 'Opera';
    } else if (/Firefox\//.test(ua)) {
        browserName = 'Firefox';
    } else if (/Chrome\//.test(ua)) {
        browserName = 'Google Chrome';
    } else if (/Safari\//.test(ua)) {
        browserName = 'Safari';
    } else {
        browserName = getBrowserNameFromBrands() ?? browserName;
    }

    browserEl.textContent = browserName;
}

function initLauncher() {
    const gameGrid = document.getElementById('game-grid');
    const autoRedirectCheckbox = document.getElementById('auto-redirect');
    const redirectOverlay = document.getElementById('redirect-overlay');
    const redirectIcon = document.getElementById('redirect-icon');
    const redirectGameName = document.getElementById('redirect-game-name');
    const redirectSeconds = document.getElementById('redirect-seconds');
    const redirectCancel = document.getElementById('redirect-cancel');

    if (
        !gameGrid ||
        !autoRedirectCheckbox ||
        !redirectOverlay ||
        !redirectIcon ||
        !redirectGameName ||
        !redirectSeconds ||
        !redirectCancel
    ) {
        return;
    }

    let redirectTimer = null;

    function saveAutoRedirectPreference(enabled) {
        if (enabled) {
            localStorage.setItem(STORAGE_KEY_AUTO_REDIRECT, 'true');
            return;
        }

        localStorage.removeItem(STORAGE_KEY_AUTO_REDIRECT);
        localStorage.removeItem(STORAGE_KEY_GAME);
    }

    function withLauncherQuery(link) {
        try {
            const url = new URL(link, window.location.href);
            url.searchParams.set(LAUNCHER_QUERY_KEY, LAUNCHER_QUERY_VALUE);
            return url.toString();
        } catch {
            return link;
        }
    }

    function onGameClick(link) {
        if (!autoRedirectCheckbox.checked) return;
        localStorage.setItem(STORAGE_KEY_GAME, link);
        localStorage.setItem(STORAGE_KEY_AUTO_REDIRECT, 'true');
    }

    function hideRedirectOverlay() {
        if (redirectTimer) {
            clearInterval(redirectTimer);
            redirectTimer = null;
        }
        redirectOverlay.hidden = true;
    }

    function cancelRedirectCountdown() {
        hideRedirectOverlay();
        autoRedirectCheckbox.checked = false;
        saveAutoRedirectPreference(false);
    }

    function startRedirectCountdown(game) {
        redirectIcon.className = `card-icon ${game.icon || ''}`;
        redirectGameName.textContent = game.name;
        redirectOverlay.hidden = false;

        let secondsRemaining = REDIRECT_DELAY_SECONDS;
        redirectSeconds.textContent = String(secondsRemaining);

        redirectTimer = setInterval(() => {
            secondsRemaining -= 1;
            if (secondsRemaining <= 0) {
                hideRedirectOverlay();
                window.location.href = withLauncherQuery(game.link);
                return;
            }

            redirectSeconds.textContent = String(secondsRemaining);
        }, 1000);
    }

    function createGameCard(game) {
        const card = document.createElement('a');
        card.className = 'card glass-panel';
        card.href = withLauncherQuery(game.link);

        const icon = document.createElement('div');
        icon.className = `card-icon ${game.icon || ''}`;
        icon.setAttribute('aria-hidden', 'true');

        const body = document.createElement('div');
        body.className = 'card-body';

        const title = document.createElement('h4');
        title.className = 'card-title';
        title.textContent = game.name;

        const description = document.createElement('p');
        description.className = 'card-desc';
        description.textContent = game.description;

        body.append(title, description);
        card.append(icon, body);

        if (game.hover_description) {
            card.classList.add('card--has-hover-desc');

            const hoverDescription = document.createElement('div');
            hoverDescription.className = 'card-hover-desc';
            hoverDescription.textContent = game.hover_description;
            card.append(hoverDescription);
        }

        card.addEventListener('click', () => onGameClick(game.link));
        return card;
    }

    function populateGames(games) {
        gameGrid.replaceChildren();

        for (const game of games) {
            gameGrid.appendChild(createGameCard(game));
        }

        const autoRedirectEnabled = localStorage.getItem(STORAGE_KEY_AUTO_REDIRECT) === 'true';
        const savedGameLink = localStorage.getItem(STORAGE_KEY_GAME);
        const selectedGame = savedGameLink ? games.find(game => game.link === savedGameLink) : null;

        if (autoRedirectEnabled && selectedGame) {
            autoRedirectCheckbox.checked = true;
            startRedirectCountdown(selectedGame);
            return;
        }

        autoRedirectCheckbox.checked = false;
        localStorage.removeItem(STORAGE_KEY_AUTO_REDIRECT);
    }

    fetch('data/games.json')
        .then(response => {
            if (!response.ok) {
                throw new Error(`Failed to load games (${response.status})`);
            }
            return response.json();
        })
        .then(populateGames)
        .catch(() => {
            gameGrid.innerHTML = '<p class="game-grid-status">Could not load games</p>';
        });

    autoRedirectCheckbox.addEventListener('change', () => {
        saveAutoRedirectPreference(autoRedirectCheckbox.checked);
    });

    redirectCancel.addEventListener('click', cancelRedirectCountdown);
}

initDeviceHealthPanel();
initBrowserInfo();
initLauncher();
