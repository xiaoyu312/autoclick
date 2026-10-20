# AutoClick

[中文](README.md)

More from the author: [FateClear](https://fateclear.com) · [Project updates on X](https://x.com/liu_xiaoyu27334)

Select a button on a web page and click it at a chosen interval while keeping your physical mouse free. AutoClick combines a Chrome/Edge extension and an Electron desktop application for authorized repetitive web tasks and commerce operations.

This public source edition preserves the existing DOM targeting, scheduling, logging and desktop window management. It contains no business datasets, account configuration, browser profiles, historical logs or prebuilt binaries. User-owned code is under the [MIT License](LICENSE); see [third-party boundaries](THIRD_PARTY_NOTICES.md).

| Variant | Entry point | Scope |
| --- | --- | --- |
| Browser extension 1.0.0 | `extension/manifest.json` | Select targets in an existing Chrome/Edge tab |
| Desktop 0.1.0 | `desktop/src/main.js` | Separate control panel and embedded target browser; Windows 10/11 x64 is the primary target |

## Features and boundaries

- Normalize a click on a button's nested text or icon to its semantic button.
- Relocate targets using product containers, identifiers or names after DOM changes.
- Configure an interval of at least one second, inspect counters and logs, and stop manually.
- Desktop uses absolute scheduling, skips missed intervals and avoids overlapping clicks.
- Desktop pauses during navigation/recovery and retries with bounded backoff while preserving the requested running state.
- The desktop controlled “讲解 / 取消讲解” toggle may perform two DOM clicks in one successful scheduled round. Round counts are not physical click counts.

The extension and desktop app have separate implementations. The extension relies on background timers and does not guarantee continuous operation through browser throttling, sleep or Service Worker restarts. Cross-origin frames, canvas interfaces, anti-automation mechanisms and controls requiring physical input are outside current guarantees. Users complete login, CAPTCHA and permissions manually.

## Load the extension

1. Enable developer mode in Chrome/Edge's extension manager.
2. Choose **Load unpacked** and select `extension/`.
3. Open an HTTP(S) page you are authorized to operate, choose the target in the extension popup, set an interval, and start.
4. Stop before choosing another target.

The manifest requests HTTP/HTTPS site access to inject DOM-click code into target pages. This is not a store-reviewed build. Installation and browser behavior were not verified during source preparation.

## Start the desktop app

Use Node.js 22 or newer. These commands are for the user to run; preparation did not install dependencies or start Electron.

```sh
cd desktop
npm ci
npm start
```

Enter an HTTP(S) URL, sign in manually if needed, select a button, and start. Closing a window hides it to the tray; use **Exit** in the tray menu to quit. The macOS launcher `desktop/启动Mac本地测试.command` uses project-local Electron after installation. A successful macOS run does not establish Windows support.

`npm run dist:win` is the portable Windows build entry. Packaging dependencies, platform compatibility, signing and binary license notices require release-environment review. No signed binary, automatic updater, installer or store release is included.

## Synthetic demo

`examples/` was authored from scratch: two fictional items and local counters, with no anonymized production snapshot. From the package root:

```sh
python3 -m http.server 8765 --bind 127.0.0.1 --directory examples
```

Open `http://127.0.0.1:8765/` in a regular browser or AutoClick Desktop. First select Demo Item A's counter button. Desktop can also exercise Demo Item B's controlled toggle and DOM replacement. Press Ctrl+C to stop the demo server. No server or browser demo was run during preparation.

## Local checks

From the package root, without npm dependencies:

```sh
node tools/test.js
node tools/check-syntax.js
```

Unit tests use Node's standard library, simulated DOM objects and synthetic inputs. The temporary-directory test creates and removes only its own directory. The optional desktop `npm run smoke` starts Electron and a local HTTP server with a new temporary profile. It was not run during preparation.

Maturity: MVP source candidate. Node unit tests and syntax checks do not prove compatibility with production sites, Windows tray/power behavior, extended background execution or the browser extension lifecycle. Those require separate manual acceptance.

## Data handling

No API key or `.env` is needed. At runtime, the extension stores target descriptors, state and logs in `chrome.storage.local`; desktop stores state, logs and an isolated browser session in Electron's application data directory. Descriptors and exported logs may contain page URLs, product text and DOM attributes, and some paths retain full URLs. **Do not commit runtime records or attach them to public issues without review.** Existing profiles and records were excluded from this package.

Original icons were excluded. Included icons are deterministic original graphics generated by `tools/generate-icons.py` using Python's standard library. This experimental source release does not imply store approval or live-platform validation.

Try [FateClear](https://fateclear.com) for free birthday charting and interpretation, or follow [me on X](https://x.com/liu_xiaoyu27334) for new projects and updates.
