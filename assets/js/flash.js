// In-browser firmware flashing via picoflash (WebUSB / PICOBOOT).
//
// The running adapter (VID 2fe3/cafe/239a) cannot be flashed directly: the
// RP2040 must be in BOOTSEL mode, where it re-enumerates as the bootrom
// (2e8a:0003). On firmware that supports it we trigger that reboot over USB
// (command 0x43); otherwise the user enters BOOTSEL by hand. Either way the
// bytes are flashed in-browser, so there is no download or drag-and-drop —
// and the latest release can be (re)flashed onto any currently-installed
// version, which also doubles as recovery for a bad/unknown build.
//
// WebUSB only — Chromium-based browsers. Firefox/Safari are not supported
// (WebUSB is required to reach the bootrom; WebSerial cannot).

// Import the classes directly rather than via ./picoflash/index.js — that barrel
// re-exports FLASH_END_RP2040/RP2350, which constants.js never defines, so loading
// it throws. The individual modules only import constants that exist.
import { Picoboot } from './picoflash/picoboot.js';
import { Target } from './picoflash/target.js';
import { uf2ToFlashBuffer } from './picoflash/uf2.js';

const PICOBOOT_BOOTROM_VID = 0x2e8a;
const REBOOT_BOOTLOADER_CMD = 0x43;
const REBOOT_DELAY_MS = 500;

export function createFirmwareUpdater({
    containerEl,
    iconEl,
    headingTextEl,
    versionEl,
    versionRowEl,
    versionSelectEl,
    flashBtn,
    selectBtn,
    statusEl,
    progressEl,
    fallbackEl,
    downloadLinkEl,
    supportsOneClick,
}) {
    // phase: idle | downloading | awaiting-bootrom | flashing | done | error
    let phase = 'idle';
    let device = null;
    let cmdEpOut = null;
    let family = null;
    let version = null;
    let target = null; // { latest, uf2, updateAvailable, deviceVersion, versions[] }
    let selected = null; // chosen { version, uf2 } to flash (defaults to latest)
    let firmware = null; // { address, data } parsed from the .uf2
    let lastFlashedTo = null;
    let serialSend = null; // set in WebSerial mode — flashing is manual there (no PICOBOOT)
    let usbConnectListener = null;
    let bootromDevice = null; // set when the connected device is already in BOOTSEL

    function versionList() {
        return target?.versions?.length
            ? target.versions
            : [{ version: target?.latest, uf2: target?.uf2 }];
    }

    function inFlight() {
        return phase === 'downloading' || phase === 'awaiting-bootrom' || phase === 'flashing';
    }

    function setStatus(text, kind) {
        if (!statusEl) return;
        statusEl.textContent = text || '';
        statusEl.classList.remove('device-update-status--error', 'device-update-status--ok');
        if (kind === 'error') statusEl.classList.add('device-update-status--error');
        if (kind === 'ok') statusEl.classList.add('device-update-status--ok');
        statusEl.hidden = !text;
    }

    function showProgress(active) {
        if (!progressEl) return;
        progressEl.hidden = !active;
        progressEl.classList.toggle('device-update-progress--active', Boolean(active));
    }

    function removeConnectListener() {
        if (usbConnectListener && navigator.usb) {
            navigator.usb.removeEventListener('connect', usbConnectListener);
        }
        usbConnectListener = null;
    }

    // Label the flash button for the chosen version: latest reads as Update /
    // Reinstall; an older pick reads as an explicit Install.
    function updateFlashLabel() {
        if (!flashBtn || !target || !selected) return;
        if (selected.version !== target.latest) {
            flashBtn.textContent = `Install v${selected.version}`;
        } else if (bootromDevice) {
            flashBtn.textContent = 'Install firmware'; // board is already in BOOTSEL
        } else {
            flashBtn.textContent = target.updateAvailable ? 'Update firmware' : 'Reinstall firmware';
        }
    }

    // Reflect the currently-selected version in the download link + button label.
    function onVersionChange() {
        const list = versionList();
        selected = list[Number(versionSelectEl?.value) || 0] ?? list[0];
        if (downloadLinkEl) {
            downloadLinkEl.href = selected.uf2 || '#';
            downloadLinkEl.download = selected.uf2 ? selected.uf2.split('/').pop() : '';
        }
        updateFlashLabel();
    }

    // Fill the version <select> (newest-first), tagging the recommended default
    // (newest 2.x = target.latest) and the build currently installed. Defaults
    // the selection to the recommended one; only shown when >1 build is bundled.
    function populateVersions() {
        const list = versionList();
        let defaultIndex = 0;
        if (versionSelectEl) {
            versionSelectEl.replaceChildren();
            list.forEach((v, i) => {
                const opt = document.createElement('option');
                opt.value = String(i);
                const tags = [];
                if (v.version === target.latest) { tags.push('recommended'); defaultIndex = i; }
                if (target.deviceVersion && v.version === target.deviceVersion) tags.push('installed');
                opt.textContent = tags.length ? `v${v.version} (${tags.join(', ')})` : `v${v.version}`;
                versionSelectEl.appendChild(opt);
            });
            versionSelectEl.value = String(defaultIndex);
        }
        if (versionRowEl) versionRowEl.hidden = list.length <= 1;
        onVersionChange();
    }

    // Render the idle "firmware status" view for the current target: update
    // available vs. up to date, a version picker, and a (re)flash button.
    function renderIdle() {
        removeConnectListener();
        containerEl.hidden = false;

        if (versionEl) versionEl.textContent = `v${target.latest}`;

        // A board already in BOOTSEL has no running firmware to compare against —
        // present it as a direct flash rather than an update.
        const actionable = bootromDevice || target.updateAvailable;
        containerEl.classList.toggle('device-update--available', actionable);
        containerEl.classList.toggle('device-update--current', !actionable);
        // iconEl is an <svg>: the `.hidden` property doesn't reflect to the
        // attribute on SVG elements, so toggle the attribute directly.
        if (iconEl) iconEl.toggleAttribute('hidden', !target.updateAvailable);
        if (headingTextEl) {
            headingTextEl.textContent = bootromDevice
                ? 'Bootloader mode — install:'
                : target.updateAvailable ? 'Update available:' : 'Up to date — latest is';
        }

        populateVersions(); // sets `selected`, download link, and button label

        if (versionSelectEl) versionSelectEl.disabled = false;
        if (flashBtn) {
            flashBtn.hidden = false;
            flashBtn.disabled = false;
        }
        if (selectBtn) {
            selectBtn.hidden = true;
            selectBtn.disabled = false;
        }
        showProgress(false);

        if (serialSend) {
            // WebSerial: in-browser PICOBOOT flashing isn't possible, so the
            // flow is manual. Reveal the download + drag steps, and relabel the
            // button to reflect that it only reboots the board into update mode.
            if (fallbackEl) fallbackEl.open = true;
            if (flashBtn) {
                flashBtn.textContent = supportsOneClick(family, version)
                    ? 'Reboot adapter to update mode'
                    : 'Flashing instructions';
            }
        }
    }

    async function startUpdate() {
        if (inFlight() || !target || !selected) return;

        // WebSerial mode: no in-browser flashing. Optionally reboot the board to
        // BOOTSEL (≥2.1.2), then the user downloads the .uf2 and drags it on.
        if (serialSend) {
            // Keep the panel (and these instructions/download) up while the board
            // drops its serial port to enter BOOTSEL — the launcher only preserves
            // the panel on disconnect while inFlight(). Reset on the next connect.
            phase = 'awaiting-bootrom';
            if (supportsOneClick(family, version)) {
                setStatus('Rebooting adapter into update mode…');
                try {
                    await serialSend(new Uint8Array([REBOOT_BOOTLOADER_CMD]));
                } catch {}
                setStatus(`Adapter is rebooting into update mode. Download v${selected.version} below and drag it onto the RPI-RP2 drive, then reconnect.`, 'ok');
            } else {
                setStatus('Hold BOOTSEL on the adapter and replug it, then download below and drag the .uf2 onto the RPI-RP2 drive, then reconnect.');
            }
            if (fallbackEl) fallbackEl.open = true;
            return;
        }

        phase = 'downloading';
        if (flashBtn) flashBtn.disabled = true;
        if (versionSelectEl) versionSelectEl.disabled = true;
        setStatus(`Downloading firmware v${selected.version}…`);
        showProgress(true);

        try {
            const res = await fetch(selected.uf2);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const bytes = new Uint8Array(await res.arrayBuffer());
            firmware = uf2ToFlashBuffer(bytes);
        } catch (err) {
            phase = 'error';
            console.error('Firmware download/parse failed:', err);
            showProgress(false);
            if (flashBtn) flashBtn.disabled = false;
            if (versionSelectEl) versionSelectEl.disabled = false;
            setStatus('Could not download the firmware. Use “Flash manually instead” below.', 'error');
            if (fallbackEl) fallbackEl.open = true;
            return;
        }

        phase = 'awaiting-bootrom';
        if (flashBtn) flashBtn.hidden = true;

        // If the board is already in BOOTSEL (connected via the Connect button),
        // flash the device we already have — no reboot, no chooser.
        if (bootromDevice) {
            await acquireAndFlash(bootromDevice);
            return;
        }

        // Otherwise get the running adapter into BOOTSEL mode. Firmware ≥ v2.1.2
        // can reboot itself there; older firmware needs a physical BOOTSEL press.
        if (supportsOneClick(family, version) && device) {
            setStatus('Adapter is rebooting into update mode… (if it doesn’t continue, click “Select adapter”).');
            try {
                await device.transferOut(cmdEpOut, new Uint8Array([REBOOT_BOOTLOADER_CMD]));
            } catch {
                // The board disconnects as it reboots; a rejected transfer is expected.
            }
            // Release our handle on the running firmware so the rebooting device
            // is reaped cleanly instead of lingering as a phantom node.
            try { await device.close(); } catch {}
        } else {
            setStatus('Hold the BOOTSEL button on the adapter, plug it back in, then click “Select adapter”.');
        }

        armBootromAcquire();
    }

    function armBootromAcquire() {
        if (selectBtn) {
            selectBtn.hidden = false;
            selectBtn.disabled = false;
        }
        // Grab the bootrom the moment it enumerates. We use the live device from
        // the connect event rather than getDevices() — the latter also returns
        // stale, disconnected grants that accumulate and throw "Access denied".
        if (navigator.usb) {
            usbConnectListener = event => {
                if (event.device?.vendorId === PICOBOOT_BOOTROM_VID) {
                    acquireAndFlash(event.device);
                }
            };
            navigator.usb.addEventListener('connect', usbConnectListener);
        }
    }

    // Return to "waiting for a bootrom device" so the user can pick it manually
    // (or replug) after an attempt couldn't open/flash a device.
    function reArmManualSelect(message) {
        phase = 'awaiting-bootrom';
        showProgress(false);
        if (selectBtn) {
            selectBtn.hidden = false;
            selectBtn.disabled = false;
        }
        if (message) {
            setStatus(`${message} Click “Select adapter” to choose it, or flash manually below.`, 'error');
        }
        if (fallbackEl) fallbackEl.open = true;
    }

    async function acquireAndFlash(dev) {
        if (phase !== 'awaiting-bootrom') return;
        let picoboot;
        try {
            picoboot = await Picoboot.fromDevice(dev);
        } catch (err) {
            console.warn('Could not prepare bootrom device:', err?.message);
            return; // a connect-event ghost; wait for a real one or manual Select
        }
        await flashWith(picoboot);
    }

    async function onSelectClick() {
        if (phase !== 'awaiting-bootrom') return;
        // Open the chooser only to (re)authorize the board. On Linux the OS can
        // report several phantom "RP2 Boot" nodes for the one physical board, so
        // we don't trust the picked entry — we then probe every granted bootrom
        // device and flash the one that actually opens (forgetting the rest).
        try {
            await Picoboot.requestDevice([new Target('RP2040')]);
        } catch (err) {
            if (err?.name === 'NotFoundError') return; // user dismissed the chooser
            console.error('Bootrom selection failed:', err);
            reArmManualSelect(`Could not open the adapter: ${err.message}.`);
            return;
        }
        await flashFirstOpenableGrant();
    }

    // Among the granted bootrom (2e8a) devices, find the one that actually opens
    // (the live board) and flash it; the rest are stale phantom nodes, so forget
    // them. Retries briefly to ride out the transient "Access denied" right after
    // re-enumeration. This is also why the manual path is as reliable as auto:
    // it never depends on which duplicate the user happened to pick.
    async function flashFirstOpenableGrant() {
        for (let attempt = 0; attempt < 3; attempt++) {
            if (phase !== 'awaiting-bootrom') return;

            let devices;
            try {
                devices = (await Picoboot.getDevices([new Target('RP2040')])) ?? [];
            } catch (err) {
                reArmManualSelect(`Could not list adapters: ${err.message}.`);
                return;
            }

            const failed = [];
            let chosen = null;
            for (const picoboot of devices) {
                try {
                    await picoboot.connect();
                    chosen = picoboot;
                    break;
                } catch {
                    await closePicoboot(picoboot); // never leave a half-open handle
                    failed.push(picoboot);
                }
            }

            if (chosen) {
                // The ones that didn't open are stale duplicates — prune them.
                for (const picoboot of failed) {
                    try { await picoboot.device?.forget?.(); } catch {}
                }
                await flashWith(chosen);
                return;
            }

            // Nothing opened yet — the live node may still be settling; retry.
            await new Promise(resolve => setTimeout(resolve, 400));
        }

        reArmManualSelect('Couldn’t open the adapter — unplug it, re-enter BOOTSEL, then click “Select adapter”.');
    }

    // Fully release a Picoboot device. picoboot.disconnect() only closes when a
    // connection was established — but connect() can open() the device and then
    // fail at claimInterface/reset, leaving the handle open. An open handle on a
    // device that later reboots is what makes the OS keep a phantom "RP2 Boot"
    // node around, so close the raw handle too.
    async function closePicoboot(picoboot) {
        try { await picoboot.disconnect(); } catch {}
        try {
            if (picoboot.device?.opened) await picoboot.device.close();
        } catch {}
    }

    // Open the PICOBOOT connection, retrying the transient "Access denied" that
    // can occur right after the bootrom re-enumerates (the device node isn't
    // immediately grabbable on Linux).
    async function connectWithRetry(picoboot) {
        for (let attempt = 0; ; attempt++) {
            try {
                return await picoboot.connect();
            } catch (err) {
                const transient = err?.name === 'SecurityError'
                    || /access denied/i.test(err?.message || '');
                await closePicoboot(picoboot); // don't leak a half-open handle
                if (!transient || attempt >= 3) throw err;
                await new Promise(resolve => setTimeout(resolve, 400));
            }
        }
    }

    async function flashWith(picoboot) {
        if (phase === 'flashing' || phase === 'done') return; // single-run guard
        phase = 'flashing';
        removeConnectListener();
        if (selectBtn) {
            selectBtn.disabled = true;
            selectBtn.hidden = true;
        }
        setStatus('Flashing… do not unplug the adapter.');
        showProgress(true);

        try {
            const connection = await connectWithRetry(picoboot);
            await picoboot.flashEraseAndWrite(firmware.address, firmware.data);
            setStatus('Update written. Rebooting adapter…');
            try {
                await connection.reboot(REBOOT_DELAY_MS);
            } catch {
                // reboot drops the USB link; a rejected transfer is expected.
            }
            await closePicoboot(picoboot);

            // Keep the bootrom grant so the next flash can auto-acquire it (the
            // connect event only fires for already-permitted devices). Stale
            // duplicates are cleared when the user presses "Select adapter".
            lastFlashedTo = selected.version;
            phase = 'done';
            showProgress(false);
            setStatus(`✓ Firmware v${selected.version} installed. Reconnecting…`, 'ok');
        } catch (err) {
            console.error('Flashing failed:', err);
            await closePicoboot(picoboot);
            // Non-terminal: re-offer Select so the user can retry / pick another device.
            reArmManualSelect(`Flashing failed: ${err.message}.`);
        }
    }

    // Called by the device-health panel whenever a running adapter is detected.
    function onDeviceReady(payload) {
        // A fresh WebSerial connection always starts clean (no in-browser flash
        // is ever in progress over serial); reset any leftover in-flight state.
        if (payload.serialSend) phase = 'idle';
        // Ignore re-detections while a (WebUSB) flash is mid-flight.
        else if (inFlight()) return;

        device = payload.device;
        cmdEpOut = payload.cmdEpOut;
        family = payload.family;
        version = payload.version;
        target = payload.target;
        bootromDevice = payload.bootrom ? payload.device : null;
        serialSend = payload.serialSend ?? null; // present → WebSerial (manual flash) mode

        if (!containerEl) return;

        // No flashable release for this device (unknown family / missing uf2).
        if (!target) {
            containerEl.hidden = true;
            phase = 'idle';
            return;
        }

        phase = 'idle';
        renderIdle();

        // Confirm a just-completed flash now that the board is back.
        if (lastFlashedTo) {
            setStatus(`✓ Firmware v${lastFlashedTo} installed.`, 'ok');
            lastFlashedTo = null;
        }
    }

    // Called when the running adapter disconnects. During an update this is the
    // board rebooting into BOOTSEL — keep the panel and let the flow continue.
    function onDeviceGone() {
        device = null;
        cmdEpOut = null;
        if (inFlight()) return false; // tell the caller not to tear down the panel
        return true;
    }

    if (flashBtn) flashBtn.addEventListener('click', () => startUpdate());
    if (selectBtn) selectBtn.addEventListener('click', () => onSelectClick());
    if (versionSelectEl) versionSelectEl.addEventListener('change', () => onVersionChange());

    return { onDeviceReady, onDeviceGone, isUpdating: inFlight };
}
