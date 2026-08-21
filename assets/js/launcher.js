import { createFirmwareUpdater } from './flash.js';
import { SerialTransport, SERIAL_FILTERS, webSerialAvailable } from './serial-transport.js';

const GBLINK_USB_FILTERS = [
    { vendorId: 0x239a },
    { vendorId: 0xcafe },
    { vendorId: 0x2fe3 },
];

const PICOBOOT_BOOTROM_VID = 0x2e8a;

// The manual "Connect" chooser also offers a board already in BOOTSEL, so a blank
// or bricked board can be flashed directly. Auto-connect (load + hotplug) stays on
// running-firmware VIDs only — the firmware updater owns bootrom devices.
const CONNECT_CHOOSER_FILTERS = [...GBLINK_USB_FILTERS, { vendorId: PICOBOOT_BOOTROM_VID }];

// Which bundled firmware family to offer when a board is connected in BOOTSEL
// (the bootrom can't tell us what was installed).
const DEFAULT_FLASH_FAMILY = 'gblink';

// Firmware version that introduced the 0x43 reboot-to-BOOTSEL command, which
// lets the launcher flash updates in-browser without a physical BOOTSEL press.
const GBLINK_REBOOT_BOOTSEL_MIN_VERSION = '2.1.2';

// Reconfigurable (Starlarkus) firmware that introduced the WebUSB landing-page
// "LAND" command. Older builds would misinterpret the query as link data.
const RECONFIGURABLE_LANDING_MIN_VERSION = '1.0.7';

const GBL_CMD_GET_FIRMWARE_INFO = 0x0f;
const GBL_CMD_SET_LED_COLOR = 0x42;   // live preview (not persisted)
const GBL_CMD_SET_WEBUSB_LANDING = 0x44;
const GBL_CMD_GET_LED_CONFIG = 0x45;
const GBL_CMD_SET_MODE_LED = 0x46;
const GBL_CMD_RESET_LED = 0x47;
const GBL_CMD_SET_CABLE_SELECTION = 0x4b; // persist the cable/SD-pin selection

// Cable selection values (firmware + <select> options): 0 auto, 1 GBA, 2 GBC.
const GBL_CABLE_AUTO = 0;

// First firmware with the persisted cable selection (0x4b / info byte 5);
// updates crossing this version migrate the device to "auto" once.
const GBLINK_CABLE_SELECTION_MIN_VERSION = '2.2.3';

// Per-mode LED slot labels, in the fixed order the firmware reports them.
const LED_SLOT_LABELS = {
    gblink: ['Idle / connected', 'Celio / GBA', 'GB / GBC', 'Printer', 'Advance Wars', 'e-Reader'],
    'reconfigurable-starlarkus': ['Connected', 'Active / link', 'Printer'],
};
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
let firmwareManifestPromise = null;

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

// The bundled-firmware manifest (assets/firmware/manifest.json) lists the .uf2
// files shipped with the launcher, newest-first per family. It's generated by
// scripts/gen-firmware-manifest.mjs — the page can't list a directory itself.
function loadFirmwareManifest() {
    if (!firmwareManifestPromise) {
        firmwareManifestPromise = fetch('assets/firmware/manifest.json')
            .then(res => {
                if (!res.ok) throw new Error(`Failed to load manifest.json (${res.status})`);
                return res.json();
            })
            .catch(err => {
                console.warn('Could not load firmware manifest:', err);
                return null;
            });
    }
    return firmwareManifestPromise;
}

// Resolve the firmware we'd flash for the connected device. All builds are the
// unified gblink firmware (bundled under assets/firmware/, listed newest-first in
// the manifest), so every adapter is offered that list. We default to the newest
// 2.x build — the current firmware line — while older 1.x builds remain
// selectable in the dropdown. Returns null only when no firmware is bundled.
function resolveFirmwareTarget(catalog, manifest, firmwareInfo) {
    const targetFamily = catalog?.[firmwareInfo.family]?.upgradeTo?.family ?? firmwareInfo.family;

    // Use the device's own builds if present, otherwise fall back to the primary
    // family (everything ships as gblink now, so e.g. reconfigurable adapters are
    // offered the gblink upgrade).
    const ownVersions = manifest?.[targetFamily];
    const versions = ownVersions ?? manifest?.[DEFAULT_FLASH_FAMILY];
    if (!versions?.length) return null;

    // Default to the newest 2.x build; if there is none, the newest overall.
    const recommended = versions.find(v => parseVersion(v.version)?.major === 2) ?? versions[0];

    let updateAvailable;
    if (!ownVersions) {
        updateAvailable = true; // different firmware line — offer the upgrade
    } else if (firmwareInfo.version == null) {
        updateAvailable = false;
    } else {
        updateAvailable = compareVersions(firmwareInfo.version, recommended.version) < 0;
    }

    return {
        latest: recommended.version,
        uf2: recommended.uf2,
        updateAvailable,
        deviceVersion: firmwareInfo.version ?? null,
        versions, // [{ version, uf2 }, ...] newest-first
    };
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

// "LAND" command for the reconfigurable firmware (≥ v1.0.7): 32-byte cafe/dead
// prefix + "LAND" + value (0/1 to set, 0xFF to query). Firmware replies with the
// current state byte. Reuses the 32-byte prefix from RECONFIGURABLE_PROBE_PREFIX.
function reconfigurableLandingPacket(value) {
    const packet = new Uint8Array(37);
    packet.set(RECONFIGURABLE_PROBE_PREFIX.subarray(0, 32), 0);
    packet.set([0x4c, 0x41, 0x4e, 0x44], 32); // "LAND"
    packet[36] = value;
    return packet;
}

async function queryReconfigurableLanding(device, iface) {
    await enableTinyUsbWebSerial(device, iface.interfaceNumber);
    await device.transferOut(iface.dataEpOut, reconfigurableLandingPacket(0xff));
    try {
        const result = await transferInWithTimeout(device, iface.dataEpIn, 8, 300);
        const data = result.data ? new Uint8Array(result.data.buffer) : new Uint8Array();
        if (data.length > 0) return data[0] !== 0;
    } catch {}
    return null; // no response → firmware predates the toggle
}

async function setReconfigurableLanding(device, iface, on) {
    await enableTinyUsbWebSerial(device, iface.interfaceNumber);
    await device.transferOut(iface.dataEpOut, reconfigurableLandingPacket(on ? 1 : 0));
}

// LED commands for the reconfigurable firmware: 32-byte prefix + 4-char tag +
// up to 4 data bytes (always 40 bytes — distinguished by tag from "LEDS").
//   "LEDG" query, "LEDM" set-mode [slot,r,g,b], "LEDS" live [r,g,b,on].
function reconfigurableLedPacket(tag, data) {
    const packet = new Uint8Array(40);
    packet.set(RECONFIGURABLE_PROBE_PREFIX.subarray(0, 32), 0);
    packet.set([tag.charCodeAt(0), tag.charCodeAt(1), tag.charCodeAt(2), tag.charCodeAt(3)], 32);
    for (let i = 0; i < data.length && i < 4; i++) packet[36 + i] = data[i];
    return packet;
}

// Locate a [count, r,g,b …] LED frame inside a buffer that may be preceded by
// stale single-byte command acks. The firmware acks LEDM/LEDS/LEDR with 'M'/'L'/'R'
// (0x4D/0x4C/0x52) which the launcher never reads, so those bytes can sit ahead of
// the LEDG reply. A real slot count is small (1..8) and every ack byte is > 8, so
// the first byte in range that has enough trailing RGB bytes is the frame start.
function parseReconfigurableLedFrame(buf) {
    for (let i = 0; i < buf.length; i++) {
        const count = buf[i];
        if (count >= 1 && count <= 8 && buf.length >= i + 1 + count * 3) {
            const colors = [];
            for (let j = 0; j < count; j++) {
                colors.push([buf[i + 1 + j * 3], buf[i + 2 + j * 3], buf[i + 3 + j * 3]]);
            }
            return colors;
        }
    }
    return null;
}

// Returns an array of [r,g,b] per slot, or null if the firmware doesn't answer.
async function queryReconfigurableLed(device, iface) {
    await enableTinyUsbWebSerial(device, iface.interfaceNumber);
    // Send the query FIRST, then read: draining beforehand is unsafe because a
    // timed-out transferIn stays armed and would swallow the reply. Instead read
    // chunks and scan for the frame, skipping any stale acks that precede it.
    await device.transferOut(iface.dataEpOut, reconfigurableLedPacket('LEDG', []));
    let buf = new Uint8Array(0);
    for (let attempt = 0; attempt < 32; attempt++) {
        let result;
        try {
            result = await transferInWithTimeout(device, iface.dataEpIn, 64, 300);
        } catch { break; }
        const chunk = result.data ? new Uint8Array(result.data.buffer) : new Uint8Array();
        if (chunk.length) {
            const merged = new Uint8Array(buf.length + chunk.length);
            merged.set(buf, 0);
            merged.set(chunk, buf.length);
            buf = merged;
        }
        const colors = parseReconfigurableLedFrame(buf);
        if (colors) return colors;
    }
    return null;
}

async function setReconfigurableModeLed(device, iface, slot, r, g, b) {
    await enableTinyUsbWebSerial(device, iface.interfaceNumber);
    await device.transferOut(iface.dataEpOut, reconfigurableLedPacket('LEDM', [slot, r, g, b]));
}

async function setReconfigurableLiveLed(device, iface, r, g, b) {
    await enableTinyUsbWebSerial(device, iface.interfaceNumber);
    await device.transferOut(iface.dataEpOut, reconfigurableLedPacket('LEDS', [r, g, b, 1]));
}

async function resetReconfigurableLed(device, iface) {
    await enableTinyUsbWebSerial(device, iface.interfaceNumber);
    await device.transferOut(iface.dataEpOut, reconfigurableLedPacket('LEDR', []));
}

async function queryGblinkFirmwareVersion(device, iface) {
    await device.transferOut(iface.cmdEpOut, new Uint8Array([GBL_CMD_GET_FIRMWARE_INFO]));

    const result = await transferInWithTimeout(device, iface.dataEpIn, 64, 500);
    const data = result.data ? new Uint8Array(result.data.buffer) : new Uint8Array();

    if (data.length >= 4 && data[0] === GBL_CMD_GET_FIRMWARE_INFO) {
        return {
            version: formatVersion(data[1], data[2], data[3]),
            // Byte 4 (firmware ≥ v2.1.2): WebUSB landing-page enabled. null when
            // the firmware predates it, so the toggle stays hidden.
            landingEnabled: data.length >= 5 ? data[4] !== 0 : null,
            // Byte 5 (firmware ≥ v2.2.3): persisted cable selection.
            cableSelection: data.length >= 6 ? data[5] : null,
        };
    }
    return null;
}

// Parse a GetLedConfig reply [0x45, count, r,g,b …] → array of [r,g,b], or null.
function parseGblinkLedReply(data) {
    if (data && data.length >= 2 && data[0] === GBL_CMD_GET_LED_CONFIG) {
        const count = data[1];
        if (data.length >= 2 + count * 3) {
            const colors = [];
            for (let i = 0; i < count; i++) {
                colors.push([data[2 + i * 3], data[3 + i * 3], data[4 + i * 3]]);
            }
            return colors;
        }
    }
    return null;
}

async function queryGblinkLedUsb(device, iface) {
    await device.transferOut(iface.cmdEpOut, new Uint8Array([GBL_CMD_GET_LED_CONFIG]));
    const result = await transferInWithTimeout(device, iface.dataEpIn, 64, 500);
    const data = result.data ? new Uint8Array(result.data.buffer) : new Uint8Array();
    return parseGblinkLedReply(data);
}

async function detectGblinkFirmware(device, iface) {
    let version = null;
    let landingEnabled = null;
    let cableSelection = null;

    try {
        const info = await queryGblinkFirmwareVersion(device, iface);
        if (info) {
            version = normalizeKnownGblinkVersion(stripVersionPrefix(info.version));
            landingEnabled = info.landingEnabled;
            cableSelection = info.cableSelection;
        }
    } catch {}

    return {
        family: 'gblink',
        label: formatKnownGblinkVersionLabel(version),
        version,
        landingEnabled,
        cableSelection,
    };
}

function buildStarlarkusReconfigurableLabel(device, landingEnabled = null) {
    const version = descriptorVersionString(device);
    return {
        family: 'reconfigurable-starlarkus',
        label: `Reconfigurable (Starlarkus) v${version}`,
        version,
        landingEnabled,
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
        let isStarlarkus = isStarlarkusReconfigurableByVersion(device);
        if (!isStarlarkus) {
            try {
                isStarlarkus = await probeStarlarkusLedProtocol(device, iface);
            } catch {}
        }

        if (isStarlarkus) {
            // The LAND command only exists on v1.0.7+. On older builds the query
            // would be forwarded over the GB link as SPI data and return garbage,
            // so gate it on the reported version (null → toggle stays hidden).
            let landingEnabled = null;
            const version = descriptorVersionString(device);
            if (version && compareVersions(version, RECONFIGURABLE_LANDING_MIN_VERSION) >= 0) {
                try {
                    landingEnabled = await queryReconfigurableLanding(device, iface);
                } catch {}
            }
            return buildStarlarkusReconfigurableLabel(device, landingEnabled);
        }

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

// Whether the connected firmware understands the 0x43 reboot-to-BOOTSEL command
// (gates one-click updates vs. a manual BOOTSEL press).
function supportsRebootToBootsel(family, version) {
    return (
        family === 'gblink' &&
        version != null &&
        compareVersions(version, GBLINK_REBOOT_BOOTSEL_MIN_VERSION) >= 0
    );
}

function createDeviceHealth({
    disconnectedEl,
    connectedEl,
    connectBtn,
    reconnectBtn,
    disconnectBtn,
    statusEl,
    firmwareEl,
    firmwareCopiedEl,
    usbIdEl,
    landingEl,
    landingToggleEl,
    cableEl,
    cableSelectEl,
    serialNoteEl,
    ledEl,
    ledRowsEl,
    ledResetBtn,
    onReady,
    onGone,
    isUpdating,
    isAwaitingReconnect,
    consumeUpdatedFrom,
}) {
    let activeDevice = null;
    let activeIface = null;
    let activeFirmware = null;
    let activeSerial = null; // SerialTransport when connected over WebSerial (Firefox fallback)
    let connecting = false;
    let firmwareCopiedTimeout = null;
    const firmwareCatalog = loadFirmwareCatalog();
    const firmwareManifest = loadFirmwareManifest();

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

    // Show the WebUSB landing-page toggle only for firmware new enough to report
    // and accept it (landingEnabled is null on older builds and in bootrom).
    function setLanding(firmwareInfo) {
        if (!landingEl) return;
        const supportsToggle = firmwareInfo?.family === 'gblink'
            || firmwareInfo?.family === 'reconfigurable-starlarkus';
        const supported = supportsToggle && firmwareInfo.landingEnabled != null;
        landingEl.hidden = !supported;
        if (supported && landingToggleEl) {
            landingToggleEl.checked = firmwareInfo.landingEnabled;
        }
    }

    // Show the cable selection only when the firmware reports one.
    function setCable(firmwareInfo) {
        if (!cableEl) return;
        const supported = firmwareInfo?.cableSelection != null;
        cableEl.hidden = !supported;
        if (supported && cableSelectEl) {
            cableSelectEl.value = String(firmwareInfo.cableSelection);
        }
    }

    // --- Per-mode LED colours ---

    const rgbToHex = (c) => '#' + c.map(x => x.toString(16).padStart(2, '0')).join('');
    const hexToRgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

    // Read the persisted per-mode colours over whichever transport is active.
    async function ledQuery() {
        const fam = activeFirmware?.family;
        if (activeSerial) {
            const reply = await activeSerial.sendCommandAwaitReply(
                new Uint8Array([GBL_CMD_GET_LED_CONFIG]), 800);
            return parseGblinkLedReply(reply);
        }
        if (!activeDevice || !activeIface) return null;
        if (fam === 'gblink') return queryGblinkLedUsb(activeDevice, activeIface);
        if (fam && fam.startsWith('reconfigurable')) return queryReconfigurableLed(activeDevice, activeIface);
        return null;
    }

    async function ledSetMode(slot, [r, g, b]) {
        const fam = activeFirmware?.family;
        if (activeSerial) {
            await activeSerial.sendCommand(new Uint8Array([GBL_CMD_SET_MODE_LED, slot, r, g, b]));
            return;
        }
        if (!activeDevice || !activeIface) return;
        if (fam === 'gblink') {
            await activeDevice.transferOut(activeIface.cmdEpOut, new Uint8Array([GBL_CMD_SET_MODE_LED, slot, r, g, b]));
        } else if (fam && fam.startsWith('reconfigurable')) {
            await setReconfigurableModeLed(activeDevice, activeIface, slot, r, g, b);
        }
    }

    // Show a colour on the LED right now (not persisted).
    async function ledShowNow([r, g, b]) {
        const fam = activeFirmware?.family;
        try {
            if (activeSerial) {
                await activeSerial.sendCommand(new Uint8Array([GBL_CMD_SET_LED_COLOR, r, g, b, 1]));
                return;
            }
            if (!activeDevice || !activeIface) return;
            if (fam === 'gblink') {
                await activeDevice.transferOut(activeIface.cmdEpOut, new Uint8Array([GBL_CMD_SET_LED_COLOR, r, g, b, 1]));
            } else if (fam && fam.startsWith('reconfigurable')) {
                await setReconfigurableLiveLed(activeDevice, activeIface, r, g, b);
            }
        } catch {}
    }

    // Live preview so the LED tracks the picker/slider while dragging.
    // Throttled — dragging fires a flood of input events and each send is a
    // USB/serial round-trip; persisting still happens on the final change.
    let lastLiveSend = 0;
    async function ledSetLive(rgb) {
        const now = Date.now();
        if (now - lastLiveSend < 40) return;
        lastLiveSend = now;
        await ledShowNow(rgb);
    }

    function renderLed(labels, colors) {
        if (!ledRowsEl) return;
        ledRowsEl.replaceChildren();
        colors.forEach((c, i) => {
            // Split the stored colour into a full-brightness hue (for the picker)
            // and a brightness percentage (for the slider) — on a WS2812 the RGB
            // magnitude IS the brightness, so this gives an intuitive two-control UI.
            const maxc = Math.max(c[0], c[1], c[2]);
            const hue = maxc > 0 ? c.map(x => Math.round((x / maxc) * 255)) : [255, 255, 255];
            const brightnessPct = Math.round((maxc / 255) * 100);

            const row = document.createElement('div');
            row.className = 'device-led-row';

            const top = document.createElement('div');
            top.className = 'device-led-top';
            const label = document.createElement('span');
            label.className = 'device-led-label';
            label.textContent = labels[i] ?? `Mode ${i}`;
            const swatch = document.createElement('input');
            swatch.type = 'color';
            swatch.className = 'device-led-swatch';
            swatch.value = rgbToHex(hue);
            top.append(label, swatch);

            const slider = document.createElement('input');
            slider.type = 'range';
            slider.className = 'device-led-brightness';
            slider.min = '0';
            slider.max = '100';
            slider.value = String(brightnessPct);
            slider.setAttribute('aria-label', `${label.textContent} brightness`);

            // Final colour = picked hue scaled by the brightness slider.
            const compose = () => {
                const h = hexToRgb(swatch.value);
                const pct = Number(slider.value);
                return h.map(x => Math.round((x * pct) / 100));
            };
            // Persist, then snap the LED back to the idle colour — the adapter
            // sits in idle while the launcher holds it, and the live preview
            // left the LED showing this row's colour.
            const persist = async () => {
                const c = compose();
                colors[i] = c;
                try {
                    await ledSetMode(i, c);
                    await ledShowNow(colors[0]);
                } catch (err) {
                    console.error('Failed to save LED color:', err);
                }
            };
            swatch.addEventListener('input', () => ledSetLive(compose()));
            slider.addEventListener('input', () => ledSetLive(compose()));
            swatch.addEventListener('change', () => { void persist(); });
            slider.addEventListener('change', () => { void persist(); });

            row.append(top, slider);
            ledRowsEl.appendChild(row);
        });
    }

    // Show the LED picker for firmware that supports per-mode colours: gblink
    // (any transport), or reconfigurable-starlarkus ≥ v1.0.7 over WebUSB.
    async function loadLed(firmwareInfo) {
        if (!ledEl) return;
        const fam = firmwareInfo?.family;
        const labels = LED_SLOT_LABELS[fam];
        const reconfigUsbOk = fam === 'reconfigurable-starlarkus' && activeDevice
            && firmwareInfo.version
            && compareVersions(firmwareInfo.version, RECONFIGURABLE_LANDING_MIN_VERSION) >= 0;
        if (!labels || (fam !== 'gblink' && !reconfigUsbOk)) {
            ledEl.hidden = true;
            return;
        }
        let colors = null;
        try { colors = await ledQuery(); } catch {}
        if (!colors || !colors.length) {
            ledEl.hidden = true;
            return;
        }
        renderLed(labels, colors);
        ledEl.hidden = false;
        return colors;
    }

    // Restore all per-mode colours to the firmware's built-in defaults, then
    // re-query so the swatches update.
    async function ledReset() {
        const fam = activeFirmware?.family;
        try {
            if (activeSerial) {
                await activeSerial.sendCommand(new Uint8Array([GBL_CMD_RESET_LED]));
            } else if (activeDevice && activeIface) {
                if (fam === 'gblink') {
                    await activeDevice.transferOut(activeIface.cmdEpOut, new Uint8Array([GBL_CMD_RESET_LED]));
                } else if (fam && fam.startsWith('reconfigurable')) {
                    await resetReconfigurableLed(activeDevice, activeIface);
                }
            }
            await new Promise(resolve => setTimeout(resolve, 50));
            const colors = await loadLed(activeFirmware);
            if (colors) await ledShowNow(colors[0]);
        } catch (err) {
            console.error('Failed to reset LED colors:', err);
        }
    }

    if (ledResetBtn) ledResetBtn.addEventListener('click', () => ledReset());

    async function updatePanel(device, firmwareInfo) {
        setField(statusEl, 'Connected');
        statusEl?.classList.remove('status-disconnected');
        statusEl?.classList.add('status-connected');

        setField(firmwareEl, firmwareInfo.label);
        setField(usbIdEl, formatUsbId(device));
        if (serialNoteEl) serialNoteEl.hidden = true; // WebUSB path
        activeFirmware = firmwareInfo;
        await maybeMigrateCableSelection(firmwareInfo);
        setLanding(firmwareInfo);
        setCable(firmwareInfo);

        const [catalog, manifest] = await Promise.all([firmwareCatalog, firmwareManifest]);
        const target = resolveFirmwareTarget(catalog, manifest, firmwareInfo);
        setConnected(true);

        // Hand off firmware status display + flashing to the firmware updater.
        onReady?.({
            device,
            cmdEpOut: activeIface?.cmdEpOut,
            family: firmwareInfo.family,
            version: firmwareInfo.version,
            target,
        });

        loadLed(firmwareInfo);
    }

    // Board connected while already in BOOTSEL: show a minimal "bootloader" panel
    // and let the updater flash the bundled firmware directly onto it.
    async function connectBootrom(dev) {
        const [catalog, manifest] = await Promise.all([firmwareCatalog, firmwareManifest]);
        const target = resolveFirmwareTarget(catalog, manifest, {
            family: DEFAULT_FLASH_FAMILY,
            version: null,
        });

        activeDevice = dev;
        activeIface = null;
        activeFirmware = null;

        setField(statusEl, 'Bootloader');
        statusEl?.classList.remove('status-disconnected');
        statusEl?.classList.add('status-connected');
        setField(firmwareEl, 'Bootloader (BOOTSEL)');
        setField(usbIdEl, formatUsbId(dev));
        if (landingEl) landingEl.hidden = true;
        if (cableEl) cableEl.hidden = true;
        if (ledEl) ledEl.hidden = true; // bootrom has no firmware to query
        setConnected(true);

        onReady?.({ device: dev, bootrom: true, family: DEFAULT_FLASH_FAMILY, version: null, target });
    }

    function resetPanel() {
        setField(statusEl, 'Disconnected');
        statusEl?.classList.remove('status-connected');
        statusEl?.classList.add('status-disconnected');
        if (landingEl) landingEl.hidden = true;
        if (cableEl) cableEl.hidden = true;
        if (serialNoteEl) serialNoteEl.hidden = true;
        if (ledEl) ledEl.hidden = true;
        setConnected(false);
        activeDevice = null;
        activeIface = null;
        activeFirmware = null;
        if (activeSerial) {
            activeSerial.close().catch(() => {});
            activeSerial = null;
        }
    }

    // Persist the WebUSB landing-page toggle on the adapter (applies next
    // reconnect). The command differs by firmware family.
    landingToggleEl?.addEventListener('change', async () => {
        const on = landingToggleEl.checked;
        try {
            if (activeSerial) {
                // GBLink over WebSerial — same command, framed by the transport.
                await activeSerial.sendCommand(new Uint8Array([GBL_CMD_SET_WEBUSB_LANDING, on ? 1 : 0]));
                return;
            }
            if (!activeDevice || !activeIface) return;
            if (activeFirmware?.family === 'gblink') {
                await activeDevice.transferOut(
                    activeIface.cmdEpOut,
                    new Uint8Array([GBL_CMD_SET_WEBUSB_LANDING, on ? 1 : 0]),
                );
            } else if (activeFirmware?.family === 'reconfigurable-starlarkus') {
                await setReconfigurableLanding(activeDevice, activeIface, on);
            }
        } catch (err) {
            console.error('Failed to set WebUSB landing-page toggle:', err);
        }
    });

    // Persist the cable selection on the adapter; the firmware applies it now.
    async function sendCableSelection(value) {
        if (activeSerial) {
            await activeSerial.sendCommand(new Uint8Array([GBL_CMD_SET_CABLE_SELECTION, value]));
            return;
        }
        if (!activeDevice || !activeIface) return;
        if (activeFirmware?.family !== 'gblink') return;
        await activeDevice.transferOut(
            activeIface.cmdEpOut,
            new Uint8Array([GBL_CMD_SET_CABLE_SELECTION, value]),
        );
    }

    cableSelectEl?.addEventListener('change', async () => {
        try {
            await sendCableSelection(Number(cableSelectEl.value));
        } catch (err) {
            console.error('Failed to set cable selection:', err);
        }
    });

    // One-time migration when an update crosses into cable-selection support:
    // persist "auto detect" so an updated adapter keeps its old behavior
    // (fresh installs default to GBC). Only the flash flow sets updatedFrom.
    async function maybeMigrateCableSelection(firmwareInfo) {
        const fromVersion = consumeUpdatedFrom?.();
        if (fromVersion == null || firmwareInfo?.cableSelection == null) return;
        if (compareVersions(fromVersion, GBLINK_CABLE_SELECTION_MIN_VERSION) >= 0) return;
        try {
            await sendCableSelection(GBL_CABLE_AUTO);
            firmwareInfo.cableSelection = GBL_CABLE_AUTO;
        } catch (err) {
            console.error('Failed to set cable selection to auto after the update:', err);
        }
    }

    // Just after a device re-enumerates (e.g. right after flashing), open() can
    // transiently fail with "Access denied" before the OS releases the node.
    // Retry a few times before giving up.
    async function openWithRetry(device) {
        for (let attempt = 0; ; attempt++) {
            try {
                await device.open();
                return;
            } catch (err) {
                const transient = err?.name === 'SecurityError'
                    || /access denied/i.test(err?.message || '');
                if (!transient || attempt >= 3) throw err;
                await new Promise(resolve => setTimeout(resolve, 400));
            }
        }
    }

    async function openDevice(device) {
        if (device.opened) await device.close();
        await openWithRetry(device);
        // NOTE: deliberately no device.reset() here. The health panel is
        // read-only (firmware info + detection probes) and doesn't need it, and
        // resetting the GBLink unified firmware (VID 0x2FE3) drops its USB
        // session — which then breaks mode-switching in the game clients (they
        // skip reset on the new firmware for this reason). reset() is also
        // unreliable on Windows. The launcher auto-connects on load, so this ran
        // on every visit.
        await device.selectConfiguration(1);
        return findVendorInterface(device);
    }

    async function connect(existingDevice = null) {
        if (connecting || activeDevice) return;
        if (!navigator.usb) {
            window.alert('WebUSB is not supported in this browser. Use Chrome or Edge to connect your adapter.');
            return;
        }

        connecting = true;
        connectBtn.disabled = true;

        let device = null;
        try {
            device = existingDevice ?? await navigator.usb.requestDevice({ filters: CONNECT_CHOOSER_FILTERS });

            // A board already in BOOTSEL has no running firmware to talk to — hand
            // it straight to the updater to flash. Don't open/claim it here; the
            // updater (picoflash) opens the bootrom interface itself.
            if (device.vendorId === PICOBOOT_BOOTROM_VID) {
                await connectBootrom(device);
                return;
            }

            const iface = await openDevice(device);
            if (!iface) throw new Error('No compatible GB Link interface found');

            await device.claimInterface(iface.interfaceNumber);
            await device.selectAlternateInterface(iface.interfaceNumber, 0);

            const firmwareInfo = await detectFirmware(device, iface);
            activeDevice = device;
            activeIface = iface;
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

    // WebSerial fallback (Firefox, or any browser without WebUSB). The GBLink
    // firmware speaks its command protocol over CDC, so health + update + landing
    // toggle work; flashing is manual (handled by the updater in serial mode).
    async function connectSerial(existingPort = null) {
        if (connecting || activeSerial || activeDevice) return;

        connecting = true;
        connectBtn.disabled = true;

        const transport = new SerialTransport();
        try {
            const port = existingPort ?? await SerialTransport.requestPort();
            await transport.open(port);
            activeSerial = transport;

            const info = transport.getInfo();
            let firmwareInfo;

            if (info.usbVendorId === GBLINK_VENDOR_ID) {
                // Full support: read firmware version + settings over serial.
                let version = null;
                let landingEnabled = null;
                let cableSelection = null;
                try {
                    const reply = await transport.sendCommandAwaitReply(
                        new Uint8Array([GBL_CMD_GET_FIRMWARE_INFO]), 1000);
                    if (reply && reply.length >= 4 && reply[0] === GBL_CMD_GET_FIRMWARE_INFO) {
                        version = normalizeKnownGblinkVersion(
                            stripVersionPrefix(formatVersion(reply[1], reply[2], reply[3])));
                        landingEnabled = reply.length >= 5 ? reply[4] !== 0 : null;
                        cableSelection = reply.length >= 6 ? reply[5] : null;
                    }
                } catch {}
                firmwareInfo = {
                    family: 'gblink',
                    label: formatKnownGblinkVersionLabel(version),
                    version,
                    landingEnabled,
                    cableSelection,
                };
            } else {
                // Reconfigurable / unknown: commands are WebUSB-only and the
                // version isn't readable over serial — offer manual flash only.
                firmwareInfo = {
                    family: 'reconfigurable-serial-limited',
                    label: 'Reconfigurable adapter',
                    version: null,
                    landingEnabled: null,
                    cableSelection: null,
                };
            }

            await updatePanelSerial(info, firmwareInfo);
        } catch (err) {
            if (err?.name !== 'NotFoundError') {
                console.error('Serial connect failed:', err);
            }
            try { await transport.close(); } catch {}
            activeSerial = null;
            resetPanel();
        } finally {
            connecting = false;
            connectBtn.disabled = false;
        }
    }

    async function updatePanelSerial(info, firmwareInfo) {
        setField(statusEl, 'Connected (WebSerial)');
        statusEl?.classList.remove('status-disconnected');
        statusEl?.classList.add('status-connected');

        setField(firmwareEl, firmwareInfo.label);
        const vid = (info.usbVendorId ?? 0).toString(16).padStart(4, '0');
        const pid = (info.usbProductId ?? 0).toString(16).padStart(4, '0');
        setField(usbIdEl, `${vid}:${pid}`);
        if (serialNoteEl) serialNoteEl.hidden = false;

        activeFirmware = firmwareInfo;
        await maybeMigrateCableSelection(firmwareInfo);
        setLanding(firmwareInfo);
        setCable(firmwareInfo);

        const [catalog, manifest] = await Promise.all([firmwareCatalog, firmwareManifest]);
        const target = resolveFirmwareTarget(catalog, manifest, firmwareInfo);
        setConnected(true);

        // Serial mode: flashing is manual. The updater reboots to BOOTSEL via the
        // serial command (≥2.1.2) then shows the download + drag steps.
        onReady?.({
            serialSend: bytes => activeSerial && activeSerial.sendCommand(bytes),
            family: firmwareInfo.family,
            version: firmwareInfo.version,
            target,
        });

        loadLed(firmwareInfo);
    }

    async function disconnect() {
        if (activeDevice?.opened) {
            try {
                await activeDevice.close();
            } catch (err) {
                console.warn('Device close failed:', err);
            }
        }
        if (activeSerial) {
            try { await activeSerial.close(); } catch {}
            activeSerial = null;
        }
        resetPanel();
    }

    function handleConnectButton() {
        if (navigator.usb) connect();
        else if (webSerialAvailable()) connectSerial();
        else window.alert('This browser supports neither WebUSB nor WebSerial. Use Chrome/Edge, or Firefox 151+.');
    }
    connectBtn.addEventListener('click', handleConnectButton);
    // The post-flash "Reconnecting…" Connect button (shown by the updater) uses the
    // same path. It's the manual fallback when a flashed board re-enumerates with a
    // different USB identity — e.g. crossing 1.x↔2.x firmware families — so the page
    // has no permission for the new device and the auto-reconnect can't fire.
    if (reconnectBtn) reconnectBtn.addEventListener('click', handleConnectButton);
    disconnectBtn.addEventListener('click', () => disconnect());

    if (!navigator.usb && webSerialAvailable()) {
        // Firefox / no-WebUSB fallback: connect over WebSerial instead.
        // No auto-connect on load — the adapter is only opened when the user
        // presses Connect, so the launcher never grabs a port it isn't using.
        navigator.serial.addEventListener('disconnect', event => {
            if (activeSerial && event.target === activeSerial.port) {
                // Mid-update (e.g. after the 0x43 reboot) the updater owns the
                // panel for the manual flash steps — leave it in place.
                const keepPanel = onGone && onGone() === false;
                activeSerial = null;
                if (!keepPanel) resetPanel();
            }
        });
    }

    if (navigator.usb) {
        // No auto-connect on initial page load: the launcher never opens an adapter
        // that's already present when the page opens, so a tab on a second monitor /
        // another browser won't grab a device in use elsewhere. We DO auto-reconnect
        // on a post-load hotplug (the 'connect' event below) — that's how the adapter
        // comes back on its own after it reboots into freshly-flashed firmware.
        navigator.usb.addEventListener('disconnect', event => {
            if (activeDevice && event.device === activeDevice) {
                // Release our handle so the departed device is reaped cleanly
                // instead of lingering as a phantom node.
                if (activeDevice.opened) activeDevice.close().catch(() => {});
                // During an update the adapter reboots into BOOTSEL; the updater
                // owns the panel until flashing finishes, so leave it in place.
                const keepPanel = onGone && onGone() === false;
                activeDevice = null;
                activeIface = null;
                if (!keepPanel) resetPanel();
            }
        });

        // Auto-reconnect ONLY the board coming back from a flash (update or
        // fresh install). Any other (re)appearing adapter may be headed for
        // another app — a game client reboots the adapter too — so leave it
        // alone; connecting again is a manual click or a tab-switch reacquire.
        navigator.usb.addEventListener('connect', event => {
            const isKnown = GBLINK_USB_FILTERS.some(f => f.vendorId === event.device.vendorId);
            if (!isKnown || activeDevice || connecting) return;
            if (isAwaitingReconnect && !isAwaitingReconnect()) return;
            connect(event.device);
        });
    }

    // --- Yield the adapter while this tab is in the background ---
    // WebUSB/WebSerial claims are exclusive: while the launcher holds the device,
    // no other tab (e.g. a game opened from here) can open it. So when this tab is
    // hidden we release our claim, and re-acquire when it's shown again. The
    // permission grant persists, so re-acquiring needs no chooser. If another tab
    // grabbed the device meanwhile, re-acquire fails quietly and we stay on the
    // connect screen — exactly what the user wants (the game keeps the adapter).
    let backgroundReleased = false;

    async function releaseForBackground() {
        if (isUpdating && isUpdating()) return;     // never let go mid-flash
        if (!activeDevice && !activeSerial) return; // nothing to release
        backgroundReleased = true;
        await disconnect();                         // closes device/serial + resetPanel
    }

    async function reacquireFromBackground() {
        if (!backgroundReleased) return;
        backgroundReleased = false;
        if (connecting || activeDevice || activeSerial) return;
        if (navigator.usb) {
            const devices = await navigator.usb.getDevices().catch(() => []);
            const known = devices.find(d =>
                GBLINK_USB_FILTERS.some(f => f.vendorId === d.vendorId));
            if (known) await connect(known);
        } else if (webSerialAvailable()) {
            const ports = await navigator.serial.getPorts().catch(() => []);
            const known = ports.find(p =>
                SERIAL_FILTERS.some(f => f.usbVendorId === p.getInfo().usbVendorId));
            if (known) await connectSerial(known);
        }
    }

    // Serialize transitions so a quick hide→show can't run re-acquire before the
    // release (and its async close) has finished settling the device handle.
    let bgTransition = Promise.resolve();
    document.addEventListener('visibilitychange', () => {
        bgTransition = bgTransition
            .then(() => (document.hidden ? releaseForBackground() : reacquireFromBackground()))
            .catch(() => {});
    });

    // Called by the updater after flashing a board that was connected while
    // already in BOOTSEL: that device won't fire a disconnect event, so drop it
    // here — otherwise the stale activeDevice blocks auto and manual reconnect.
    function releaseBootromDevice() {
        if (activeDevice?.vendorId !== PICOBOOT_BOOTROM_VID) return;
        activeDevice = null;
        activeIface = null;
    }

    return { connect, disconnect, resetPanel, releaseBootromDevice };
}

function initDeviceHealthPanel() {
    let health = null;
    const updater = createFirmwareUpdater({
        containerEl: document.getElementById('device-update'),
        iconEl: document.getElementById('device-update-icon'),
        headingTextEl: document.getElementById('device-update-heading-text'),
        versionEl: document.getElementById('device-update-version'),
        versionRowEl: document.getElementById('device-update-version-row'),
        versionSelectEl: document.getElementById('device-update-version-select'),
        fileInputEl: document.getElementById('device-update-uf2-file'),
        flashBtn: document.getElementById('device-update-flash'),
        selectBtn: document.getElementById('device-update-select'),
        statusEl: document.getElementById('device-update-status'),
        progressEl: document.getElementById('device-update-progress'),
        fallbackEl: document.getElementById('device-update-fallback'),
        downloadLinkEl: document.getElementById('device-update-link'),
        reconnectBtn: document.getElementById('device-update-reconnect'),
        supportsOneClick: supportsRebootToBootsel,
        onFlashed: () => health?.releaseBootromDevice(),
    });

    health = createDeviceHealth({
        disconnectedEl: document.getElementById('device-disconnected'),
        connectedEl: document.getElementById('device-connected'),
        connectBtn: document.getElementById('device-connect'),
        reconnectBtn: document.getElementById('device-update-reconnect'),
        disconnectBtn: document.getElementById('device-disconnect'),
        statusEl: document.getElementById('device-status'),
        firmwareEl: document.getElementById('device-firmware'),
        firmwareCopiedEl: document.getElementById('device-firmware-copied'),
        usbIdEl: document.getElementById('device-usb-id'),
        landingEl: document.getElementById('device-landing'),
        landingToggleEl: document.getElementById('device-landing-toggle'),
        cableEl: document.getElementById('device-cable'),
        cableSelectEl: document.getElementById('device-cable-select'),
        serialNoteEl: document.getElementById('device-serial-note'),
        ledEl: document.getElementById('device-led'),
        ledRowsEl: document.getElementById('device-led-rows'),
        ledResetBtn: document.getElementById('device-led-reset'),
        onReady: payload => updater.onDeviceReady(payload),
        onGone: () => updater.onDeviceGone(),
        isUpdating: () => updater.isUpdating(),
        isAwaitingReconnect: () => updater.isAwaitingReconnect(),
        consumeUpdatedFrom: () => updater.consumeUpdatedFrom(),
    });
}

function initBrowserInfo() {
    const webusbEl = document.getElementById('browser-webusb');
    const browserEl = document.getElementById('browser-name');
    if (!webusbEl || !browserEl) return;

    // Report which transport the device panel will use: WebUSB (full, incl.
    // in-browser flashing), WebSerial (fallback — health/update + manual flash),
    // or none.
    const webUsbAvailable = Boolean(navigator.usb);
    const webSerialFallback = !webUsbAvailable && webSerialAvailable();
    const transportLabel = webUsbAvailable
        ? 'WebUSB'
        : webSerialFallback ? 'WebSerial (fallback)' : 'Not available';
    const transportOk = webUsbAvailable || webSerialFallback;
    webusbEl.textContent = transportLabel;
    webusbEl.classList.add(transportOk ? 'browser-webusb--ok' : 'browser-webusb--no');

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
    const desktopGrid = document.getElementById('desktop-grid');
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

    // External cards (desktop clients) link straight out to their download page —
    // no launcher query, and they are not auto-redirect targets.
    function createGameCard(game, { external = false } = {}) {
        const card = document.createElement('a');
        card.className = 'card glass-panel';
        card.href = external ? game.link : withLauncherQuery(game.link);

        if (external) {
            card.target = '_blank';
            card.rel = 'noopener noreferrer';
        }

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

        if (!external) {
            card.addEventListener('click', () => onGameClick(game.link));
        }

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

    function populateDesktopClients(clients) {
        desktopGrid.replaceChildren();

        for (const client of clients) {
            desktopGrid.appendChild(createGameCard(client, { external: true }));
        }
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

    if (desktopGrid) {
        fetch('data/desktop.json')
            .then(response => {
                if (!response.ok) {
                    throw new Error(`Failed to load desktop clients (${response.status})`);
                }
                return response.json();
            })
            .then(populateDesktopClients)
            .catch(() => {
                desktopGrid.innerHTML = '<p class="game-grid-status">Could not load desktop clients</p>';
            });
    }

    autoRedirectCheckbox.addEventListener('change', () => {
        saveAutoRedirectPreference(autoRedirectCheckbox.checked);
    });

    redirectCancel.addEventListener('click', cancelRedirectCountdown);
}

initDeviceHealthPanel();
initBrowserInfo();
initLauncher();
