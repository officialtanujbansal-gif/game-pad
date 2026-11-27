# OmniRemote TV (initial beta)

OmniRemote TV is a separate TV-control project inside this repository. It has three parts:

- `omni-remote-tv/`: native Android TV / Fire TV receiver APK.
- `phone-remote/`: mobile-first phone remote, installable from the browser as a PWA.
- `cloud-relay/`: Node.js WebSocket relay. The phone and TV both make outbound connections to it, so they do not need to be on the same Wi-Fi network and no router port-forwarding is required.

## Current feature scope

The first receiver implements secure device registration, six-digit pairing codes, TV-side approval, reconnecting WebSocket sessions, D-pad navigation where the OS exposes it, Back, Home, volume up/down, mute, and the system power menu.

This is a beta foundation, not a universal TV remote yet:

- Full system D-pad navigation through Android's global accessibility actions requires Android API 33 or newer (Android 13+).
- Fire OS 7 is based on API 28; Fire OS 8 spans API 29–30; Fire OS 14 spans API 31–34; and Fire OS 16 spans API 35–36. Only Fire OS variants running API 33 or newer expose the D-pad actions used by this receiver. On older variants the TV can connect to the relay, and some actions such as volume / Back / Home may work, but full D-pad navigation is not available through this adapter. A separate legacy Fire TV input adapter is still needed.
- Android / Fire OS versions and vendor firmware differ. Test the APK on the actual TV before relying on it.
- Power Menu opens the TV's system power dialog. It is not a guaranteed power-off command. Waking a fully powered-off TV is not supported by this first receiver; standby / network-wake support is model-dependent.
- Text entry, app launching, channel control, Samsung Tizen, and LG webOS are not included in this first beta.

The Fire TV platform is AOSP-based but has OS-version differences from Android TV. See Amazon's [Fire TV development overview](https://developer.amazon.com/docs/fire-tv/getting-started-developing-apps-and-games.html) and Android's [AccessibilityService API](https://developer.android.com/reference/android/accessibilityservice/AccessibilityService).

## Build the Android receiver

The GitHub Actions workflow `.github/workflows/build-omni-remote-tv.yml` builds a debug APK when files in `omni-remote-tv/` change.

1. Open the repository's **Actions** tab.
2. Open **Build OmniRemote TV Android APK**.
3. Download the `OmniRemote-TV-Android-APK` artifact.
4. Extract the APK and sideload it on the Android TV / Fire TV device.

The APK is currently a debug-signed sideload build. It is not published to Google Play or the Amazon Appstore.

### Manual build

Requirements: JDK 17, Android SDK Platform 35, and Gradle 8.10.2.

```bash
cd omni-remote-tv
gradle --no-daemon :app:assembleDebug
```

APK output:

```
omni-remote-tv/app/build/outputs/apk/debug/app-debug.apk
```

For Fire TV, enable Developer Options / ADB Debugging and install the APK using ADB from a computer on the same LAN:

```bash
adb install -r app-debug.apk
```

Android TV device installation options vary by manufacturer. Use a trusted sideload method and keep the APK from this repository.

## Deploy the cloud relay

The relay also serves the phone PWA at its root URL.

### Render blueprint

1. Create a Render account and connect this GitHub repository.
2. Use the blueprint file `cloud-relay/render.yaml` from the repository root.
3. The blueprint configures a Docker web service and a persistent disk mounted at `/var/data`.
4. Wait for the service health check at `/healthz` to pass.

The blueprint uses a paid service plan because pairing records must survive deploys and restarts. Do not remove the persistent disk unless you are happy to lose paired-device records. A self-hosted Docker/VPS deployment with a persistent `/data` volume and HTTPS/WSS reverse proxy is also supported.

For a manual Docker deployment from the repository root:

```bash
docker build -f cloud-relay/Dockerfile -t omni-remote-tv .
docker run --restart unless-stopped -p 8787:8787 -v omni-remote-data:/data -e OR_DATA_DIR=/data omni-remote-tv
```

Put the service behind a TLS reverse proxy before using it over the internet. The public phone URL must be HTTPS and the TV WebSocket endpoint must be WSS. Do not expose an unencrypted public WebSocket endpoint.

## Pair and use

1. Open the deployed relay HTTPS URL on the phone. It serves the OmniRemote phone interface.
2. Open OmniRemote TV on the television.
3. Enter the relay WebSocket URL in the TV app, for example `wss://your-service.example/ws`, then tap **Save Address / Connect**.
4. On the TV, open **Enable Remote Input** and enable **OmniRemote TV input** in Accessibility settings.
5. The TV app displays a six-digit code. Enter it on the phone page.
6. Approve the phone pairing request on the television.
7. Keep the TV receiver allowed to run in the background. The phone can then control it from another network as long as both devices have internet access and the relay is online.

## Security model

- The TV creates a random device ID and a 256-bit device token. The token is stored on the TV; the relay stores only its SHA-256 hash.
- The phone creates a separate remote token. The browser stores it locally; the relay stores only its hash.
- Pairing codes expire after four minutes, are rate-limited by source IP, and require explicit approval on the TV.
- The relay forwards only an allow-list of remote actions to the paired TV.
- Pairing hashes are stored in `OR_DATA_DIR/devices.json`. Back up the persistent volume securely.
- Use a unique relay URL and HTTPS/WSS. Do not publish the database file or device tokens.

## Current validation status

The current Android receiver source at commit `336ae31079d5fe6ab62823899c84398666c7f163` compiled successfully in GitHub Actions. The resulting debug APK artifact is `OmniRemote-TV-Android-APK` (workflow run [46034975135](https://github.com/officialtanujbansal-gif/game-pad/actions/runs/46034975135)). The relay integration tests, including pairing approval, command forwarding, capability persistence, phone re-authentication and remote revocation, passed in [run 46035022563](https://github.com/officialtanujbansal-gif/game-pad/actions/runs/46035022563); the Docker image also built successfully.

CI confirms that the source builds and the relay protocol tests pass. It does not prove every Fire TV / Android TV model accepts every command. No physical television has been tested yet. Physical-device testing is still required, especially for older Fire OS D-pad navigation, vendor-specific volume behaviour, and background-service survival after the TV app is closed or the device sleeps.
